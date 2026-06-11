import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.rafitol.ytdownloader',
  appName: 'ytDownloader',
  // The compiled Vite SPA is bundled into the app (served from the native
  // origin). Build it with `npm run build:mobile` so VITE_API_BASE points at
  // the public backend before `cap sync` copies dist/ here.
  webDir: 'dist',
  plugins: {
    // Route window.fetch/XHR through the native HTTP client. This bypasses the
    // WebView CORS sandbox and uses the native cookie jar, so the JSON API +
    // login/whoami work cross-origin with no backend CORS changes. (<audio>,
    // downloads and WebSockets still go through the WebView — those auth via
    // the `mt` media token instead.)
    CapacitorHttp: { enabled: true },
  },
  server: {
    // App origin stays https://localhost; the backend must be reachable over
    // HTTPS (no cleartext) for cookies/media to work.
    androidScheme: 'https',
  },
}

export default config
