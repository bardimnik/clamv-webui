package info.trizub.clamav.webclient.config;

import info.trizub.clamav.webclient.web.NativeClamdtopWebSocketHandler;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

/**
 * Registers the WebSocket endpoint that streams the native {@code clamdtop} TUI
 * to the browser (see {@link NativeClamdtopWebSocketHandler}).
 */
@Configuration
@EnableWebSocket
public class NativeClamdtopWebSocketConfig implements WebSocketConfigurer {

    private final NativeClamdtopWebSocketHandler nativeClamdtopWebSocketHandler;

    public NativeClamdtopWebSocketConfig(NativeClamdtopWebSocketHandler nativeClamdtopWebSocketHandler) {
        this.nativeClamdtopWebSocketHandler = nativeClamdtopWebSocketHandler;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(nativeClamdtopWebSocketHandler, "/ws/clamdtop")
                .setAllowedOriginPatterns("*");
    }
}
