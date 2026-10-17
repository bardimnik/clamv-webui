package info.trizub.clamav.webclient.web;

import info.trizub.clamav.webclient.model.ClamdEndpoint;
import info.trizub.clamav.webclient.service.EndpointService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;

/**
 * Streams the native {@code clamdtop} TUI to the browser over a WebSocket.
 *
 * <p>The {@code clamdtop} binary is run inside the web-client container in a pseudo-terminal
 * (via {@code script}) and pointed at the selected clamd endpoint (TCP {@code host:port} or a
 * UNIX socket path). See also {@code /ws/clamdtop} registered by
 * {@code NativeClamdtopWebSocketConfig}.</p>
 *
 * <p>Because {@code clamdtop} is only used here to observe the remote daemon, the image has to
 * contain the {@code clamdtop} binary (Debian/Ubuntu package {@code clamav-daemon}) and the
 * {@code script} utility (package {@code util-linux}/{@code bsdutils}).</p>
 */
@Component
public class NativeClamdtopWebSocketHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(NativeClamdtopWebSocketHandler.class);

    private final EndpointService endpoints;
    private final ExecutorService executor = Executors.newCachedThreadPool(new ClamdtopThreadFactory());
    private final Map<String, RunningClamdtop> running = new ConcurrentHashMap<>();

    public NativeClamdtopWebSocketHandler(EndpointService endpoints) {
        this.endpoints = endpoints;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        Map<String, String> params = queryParams(session.getUri());
        int rows = boundedInt(params.get("rows"), 24, 120, 42);
        int cols = boundedInt(params.get("cols"), 80, 300, 180);

        ClamdEndpoint endpoint = resolveEndpoint(params.get("endpointId"));
        if (endpoint == null) {
            send(session, "No clamd endpoint is configured.\r\n");
            session.close(CloseStatus.NOT_ACCEPTABLE.withReason("no endpoint"));
            return;
        }

        String spec = clamdtopSpec(endpoint);
        List<String> command = nativeClamdtopCommand(spec, rows, cols);

        ProcessBuilder processBuilder = new ProcessBuilder(command);
        processBuilder.redirectErrorStream(true);
        processBuilder.environment().put("TERM", "xterm-256color");
        processBuilder.environment().put("TERMINFO", "/usr/share/terminfo");
        processBuilder.environment().put("TERMINFO_DIRS", "/usr/share/terminfo:/etc/terminfo");
        processBuilder.environment().put("NCURSES_NO_UTF8_ACS", "1");
        processBuilder.environment().put("COLUMNS", Integer.toString(cols));
        processBuilder.environment().put("LINES", Integer.toString(rows));

        try {
            Process process = processBuilder.start();
            running.put(session.getId(), new RunningClamdtop(process));
            executor.submit(() -> streamOutput(session, process, endpoint, spec));
        } catch (IOException e) {
            log.warn("Unable to start native clamdtop for {}", spec, e);
            send(session, "Unable to start native clamdtop: " + e.getMessage() + "\r\n");
            send(session, "Make sure the Docker image was rebuilt so the clamdtop package is installed.\r\n");
            session.close(CloseStatus.SERVER_ERROR.withReason("clamdtop start failed"));
        }
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        RunningClamdtop current = running.get(session.getId());
        if (current == null || !current.process.isAlive()) {
            return;
        }
        String payload = message.getPayload();
        if (payload.startsWith("__resize__")) {
            return;
        }
        try {
            OutputStream input = current.process.getOutputStream();
            input.write(payload.getBytes(StandardCharsets.UTF_8));
            input.flush();
        } catch (IOException e) {
            log.debug("Failed to write clamdtop input", e);
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        stop(session.getId());
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) {
        log.debug("Native clamdtop websocket transport error", exception);
        stop(session.getId());
    }

    private void streamOutput(WebSocketSession session, Process process, ClamdEndpoint endpoint, String spec) {
        try (InputStream input = process.getInputStream()) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1 && session.isOpen()) {
                send(session, new String(buffer, 0, read, StandardCharsets.UTF_8));
            }

            boolean exited = process.waitFor(2L, TimeUnit.SECONDS);
            if (session.isOpen() && exited) {
                send(session, "\r\n[clamdtop exited with code " + process.exitValue()
                        + " for " + endpoint.getName() + " / " + spec + "]\r\n");
                session.close(CloseStatus.NORMAL.withReason("clamdtop exited"));
            }
        } catch (Exception e) {
            if (session.isOpen()) {
                try {
                    send(session, "\r\n[clamdtop stream error: " + e.getMessage() + "]\r\n");
                } catch (Exception ignored) {
                    // session is likely gone; nothing else we can do
                }
            }
        } finally {
            stop(session.getId());
        }
    }

    private ClamdEndpoint resolveEndpoint(String rawEndpointId) {
        try {
            if (rawEndpointId != null && !rawEndpointId.isBlank()) {
                return endpoints.get(Long.parseLong(rawEndpointId));
            }
        } catch (Exception e) {
            log.debug("Invalid native clamdtop endpoint id: {}", rawEndpointId, e);
        }
        return endpoints.defaultEndpointOrEnsure();
    }

    private List<String> nativeClamdtopCommand(String clamdtopSpec, int rows, int cols) {
        String command = "stty rows " + rows + " cols " + cols + " 2>/dev/null || true; "
                + "export TERM=xterm-256color TERMINFO=/usr/share/terminfo "
                + "TERMINFO_DIRS=/usr/share/terminfo:/etc/terminfo NCURSES_NO_UTF8_ACS=1 "
                + "COLUMNS=" + cols + " LINES=" + rows + "; "
                + "if [ ! -e /usr/share/terminfo/x/xterm-256color ] && [ ! -e /etc/terminfo/x/xterm-256color ] "
                + "&& { [ -e /usr/share/terminfo/x/xterm ] || [ -e /etc/terminfo/x/xterm ]; }; "
                + "then export TERM=xterm; fi; exec clamdtop " + shellQuote(clamdtopSpec);
        return List.of("script", "-qfec", command, "/dev/null");
    }

    private String clamdtopSpec(ClamdEndpoint endpoint) {
        String host = Objects.toString(endpoint.getHost(), "").trim();
        int port = endpoint.getPort();

        if (host.isBlank()) {
            host = "localhost";
        }
        if (host.startsWith("/")) {
            return host;
        }
        if (host.indexOf(':') >= 0 && !(host.startsWith("[") && host.endsWith("]"))) {
            host = "[" + host + "]";
        }
        return host + ":" + port;
    }

    private String shellQuote(String value) {
        return "'" + value.replace("'", "'\"'\"'") + "'";
    }

    private int boundedInt(String raw, int min, int max, int fallback) {
        try {
            int value = Integer.parseInt(raw);
            return Math.max(min, Math.min(max, value));
        } catch (Exception ignored) {
            return fallback;
        }
    }

    private Map<String, String> queryParams(URI uri) {
        Map<String, String> params = new HashMap<>();
        if (uri == null || uri.getRawQuery() == null || uri.getRawQuery().isBlank()) {
            return params;
        }
        for (String pair : uri.getRawQuery().split("&")) {
            int idx = pair.indexOf('=');
            String key = idx >= 0 ? pair.substring(0, idx) : pair;
            String value = idx >= 0 ? pair.substring(idx + 1) : "";
            params.put(URLDecoder.decode(key, StandardCharsets.UTF_8),
                    URLDecoder.decode(value, StandardCharsets.UTF_8));
        }
        return params;
    }

    private void send(WebSocketSession session, String text) throws IOException {
        synchronized (session) {
            if (session.isOpen()) {
                session.sendMessage(new TextMessage(text));
            }
        }
    }

    private void stop(String sessionId) {
        RunningClamdtop current = running.remove(sessionId);
        if (current == null) {
            return;
        }
        try {
            // Send 'q' so clamdtop can restore the terminal before exiting.
            current.process.getOutputStream().write('q');
            current.process.getOutputStream().flush();
        } catch (Exception ignored) {
            // process may have already exited
        }
        current.process.destroy();
        try {
            if (!current.process.waitFor(750L, TimeUnit.MILLISECONDS)) {
                current.process.destroyForcibly();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            current.process.destroyForcibly();
        }
    }

    private static class ClamdtopThreadFactory implements ThreadFactory {
        private int count = 0;

        @Override
        public synchronized Thread newThread(Runnable runnable) {
            Thread thread = new Thread(runnable, "native-clamdtop-" + (++count));
            thread.setDaemon(true);
            return thread;
        }
    }

    private record RunningClamdtop(Process process) {
    }
}
