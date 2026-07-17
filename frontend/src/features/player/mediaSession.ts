import { Capacitor } from '@capacitor/core'
import { MediaSession } from '@jofr/capacitor-media-session'

/**
 * One media-session surface for both platforms.
 *
 * On the web we drive `navigator.mediaSession` directly. In the native
 * (Capacitor) app we route through @jofr/capacitor-media-session, which backs
 * the same controls with a real Android MediaSession **and a foreground
 * service** — that service is what keeps the WebView's <audio> playing (and the
 * `ended → next` auto-advance firing) when the screen is off, plus shows the
 * lock-screen / notification controls. Setting the playback state to 'playing'
 * is what starts the service, so we always push it.
 */
const isNative = Capacitor.isNativePlatform()

type Meta = {
  title: string
  artist: string
  album?: string
  artworkUrl?: string | null
}
type Action =
  | 'play'
  | 'pause'
  | 'previoustrack'
  | 'nexttrack'
  | 'seekto'
  | 'seekbackward'
  | 'seekforward'
  | 'stop'

/** The subset of MediaSession action details we consume. Both the web
 * `MediaSessionActionDetails` and the plugin's `ActionDetails` are supersets of
 * this, so a handler typed against it works on either platform. `seekTime` is
 * an absolute target (seekto); `seekOffset` is a relative delta (seek±). */
export type MediaActionDetails = { seekTime?: number | null; seekOffset?: number | null }

function artworkOf(url?: string | null) {
  // One already-resolved, verified URL (the caller passes the square YT Music
  // cover when available). Labelled square — it is (1080×1080) — so the OS
  // doesn't expect a 16:9 frame. The native plugin loads this single URL; the
  // web session uses it for every slot.
  return url ? [{ src: url, sizes: '1080x1080', type: 'image/jpeg' }] : []
}

/**
 * Artwork that the @jofr plugin's NATIVE bitmap loader can handle without ever
 * touching the network — which means a `data:` URL, or nothing.
 *
 * That loader does a blocking `HttpURLConnection.connect()` on any http(s) URL
 * with NO error handling, so the moment a fetch fails it throws on the bridge
 * thread and crashes the whole app. "Fails" includes: a downloaded cover's
 * `https://localhost/_capacitor_file_/…` (no native server on :443), any remote
 * URL when truly offline, AND remote URLs on WiFi-without-internet (where
 * `navigator.onLine` is still true). There's no reliable way to know a URL is
 * reachable, so we never hand the plugin one. The WebView's own
 * navigator.mediaSession — which is what actually renders the notification
 * artwork — still gets the full URL and loads it via Chromium when it can.
 */
function nativeSafeArtwork(url?: string | null): string | null {
  return url && url.startsWith('data:') ? url : null
}

// On native we feed BOTH sessions: the WebView's automatic navigator.mediaSession
// (the one Android's notification actually renders its artwork from) AND the
// plugin (whose foreground service enables background playback). Setting only
// the plugin left the WebView session on its default art — the blurry/16:9
// notification image. The web build just uses navigator.mediaSession.

const hasWebMS = typeof navigator !== 'undefined' && 'mediaSession' in navigator

export function msSetMetadata(m: Meta | null): void {
  if (hasWebMS) {
    navigator.mediaSession.metadata = m
      ? new MediaMetadata({
          title: m.title,
          artist: m.artist,
          album: m.album,
          artwork: artworkOf(m.artworkUrl),
        })
      : null
  }
  if (isNative && m) {
    void MediaSession.setMetadata({
      title: m.title,
      artist: m.artist,
      album: m.album,
      artwork: artworkOf(nativeSafeArtwork(m.artworkUrl)),
    })
  }
}

export function msSetPlaybackState(state: 'playing' | 'paused' | 'none'): void {
  if (hasWebMS) navigator.mediaSession.playbackState = state
  if (isNative) void MediaSession.setPlaybackState({ playbackState: state })
}

export function msSetActionHandler(
  action: Action,
  handler: ((details: MediaActionDetails) => void) | null,
): void {
  if (hasWebMS) {
    try {
      navigator.mediaSession.setActionHandler(action, handler)
    } catch {
      // Some browsers throw NotSupportedError for actions they don't implement
      // (e.g. seekto on older Safari) — degrade gracefully rather than crash.
    }
  }
  if (isNative) {
    void MediaSession.setActionHandler({ action }, handler ? (d) => handler(d) : null)
  }
}

export function msSetPosition(durationSec: number, positionSec: number, playing: boolean): void {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return
  const position = Math.max(0, Math.min(positionSec, durationSec))
  // playbackRate MUST be non-zero: the Web MediaSession spec rejects 0 and
  // throws synchronously, and this runs inside a React effect that sits above
  // the ErrorBoundary — a single throw on pause / track-end unmounts the whole
  // app to a blank page. Paused state is conveyed via setPlaybackState('paused'),
  // not via a zero rate, so we always report the real (positive) rate.
  void playing
  const state = { duration: durationSec, position, playbackRate: 1 }
  if (hasWebMS && navigator.mediaSession.setPositionState) {
    navigator.mediaSession.setPositionState(state)
  }
  if (isNative) void MediaSession.setPositionState(state)
}
