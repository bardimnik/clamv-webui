package info.trizub.clamav.webclient.web;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpHeaders;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.servlet.LocaleResolver;

import java.net.URI;
import java.util.Locale;

/**
 * Legacy routes kept for backwards compatibility with the original project.
 * The application UI has been expanded; use /dashboard, /scan, /jobs, /admin/*.
 */
@Controller
public class ClamAVWebClientController {

    private final LocaleResolver localeResolver;

    public ClamAVWebClientController(LocaleResolver localeResolver) {
        this.localeResolver = localeResolver;
    }

    @GetMapping(value = {"/settings"})
    public String settings(Authentication auth) {
        if (auth != null && auth.getAuthorities().stream().anyMatch(a -> a.getAuthority().equals("ROLE_ADMIN"))) {
            return "redirect:/admin/settings";
        }
        return "redirect:/dashboard";
    }

    @GetMapping({"/ping","/version","/stats","/reload"})
    public String legacyOps() {
        return "redirect:/dashboard";
    }

    @GetMapping({"/scanFolder","/scanFile"})
    public String legacyScan() {
        return "redirect:/scan";
    }

    @GetMapping("/setLocale")
    public String setLocale(@RequestParam String lang,
                            HttpServletRequest req,
                            @RequestHeader(value = HttpHeaders.REFERER, required = false) String referer) {
        localeResolver.setLocale(req, null, Locale.forLanguageTag(lang));
        String target = sameOriginPath(referer, req);
        return "redirect:" + (target != null ? target : "/dashboard");
    }

    /**
     * Returns the path (+ query) of the referer when it points back to this host, so that switching
     * the language keeps the user on the page they were viewing. Returns {@code null} otherwise
     * (guards against open redirects).
     */
    private String sameOriginPath(String referer, HttpServletRequest req) {
        if (referer == null || referer.isBlank()) {
            return null;
        }
        try {
            URI uri = URI.create(referer);
            String host = uri.getHost();
            if (host == null || !host.equalsIgnoreCase(req.getServerName())) {
                return null;
            }
            String path = uri.getRawPath();
            if (path == null || path.isBlank() || !path.startsWith("/")) {
                return null;
            }
            return uri.getRawQuery() != null ? path + "?" + uri.getRawQuery() : path;
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
