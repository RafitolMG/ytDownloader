# Media-session QA checklist

Manual verification for the lock-screen / notification / OS "now playing"
controls after the media-session work (seek/skip/stop controls + data-URL
artwork). The code drives both `navigator.mediaSession` (web + WebView) and the
`@jofr/capacitor-media-session` plugin (native foreground service). See
`frontend/src/features/player/mediaSession.ts` and `nativeCover.ts`.

Build the APK with **`npm run build:mobile && npx cap sync`** (never plain
`npm run build` for the app — it drops `VITE_API_BASE`).

## Android — native APK (notification + lock screen)
- [ ] Play a track → notification appears with **title, artist, album**.
- [ ] **Artwork** shows in the notification and on the lock screen (online track).
- [ ] **Offline**: download a playlist, enable airplane mode, play a downloaded
      track → artwork still shows (read from disk as a data URL, not the network).
- [ ] A track with **no cover** shows the OS default without crashing.
- [ ] **Scrubber**: drag it in the notification/lock screen → playback jumps to
      that position (`seekto`).
- [ ] **±10s** skip buttons (if the OS surfaces them) move by 10 seconds.
- [ ] **prev / next** change track; **play/pause** toggles.
- [ ] **stop** (swipe away / stop action) clears playback and the notification.
- [ ] **Screen off**: audio keeps playing and auto-advances (foreground service).
- [ ] Position stays roughly in sync while playing (OS extrapolates) and after a
      seek/pause.

## Web — OS "now playing" widgets
Drive from Chrome (desktop) / the mobile browser; confirm the same session:
- [ ] **Chrome media hub** (the note-icon in the toolbar): metadata + artwork,
      play/pause, prev/next, and the seek bar all work.
- [ ] **macOS** Now Playing (Control Center / Touch Bar): metadata + artwork; the
      scrubber seeks.
- [ ] **Windows** SMTC (media overlay on volume keys): metadata + artwork,
      transport + seek.
- [ ] Mobile browser lock screen (Android Chrome): metadata, artwork, transport.

## Notes / known bounds
- Artwork on native is downscaled to 512px JPEG (data URL) to keep the metadata
  payload small; the now-playing screen in-app still uses the full-res URL.
- `seekOffset` is honoured when the platform provides it, else ±10s.
- Android Auto is **out of scope** here — it needs a native
  `MediaBrowserServiceCompat`, which the plugin doesn't provide (see the
  media/Android-Auto plan).
