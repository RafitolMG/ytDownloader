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
type Action = 'play' | 'pause' | 'previoustrack' | 'nexttrack'

function artworkOf(url?: string | null) {
  // One already-resolved, verified URL (the caller passes the square YT Music
  // cover when available). Labelled square — it is (1080×1080) — so the OS
  // doesn't expect a 16:9 frame. The native plugin loads this single URL; the
  // web session uses it for every slot.
  return url ? [{ src: url, sizes: '1080x1080', type: 'image/jpeg' }] : []
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
      artwork: artworkOf(m.artworkUrl),
    })
  }
}

export function msSetPlaybackState(state: 'playing' | 'paused' | 'none'): void {
  if (hasWebMS) navigator.mediaSession.playbackState = state
  if (isNative) void MediaSession.setPlaybackState({ playbackState: state })
}

export function msSetActionHandler(action: Action, handler: (() => void) | null): void {
  if (hasWebMS) navigator.mediaSession.setActionHandler(action, handler)
  if (isNative) {
    void MediaSession.setActionHandler({ action }, handler ? () => handler() : null)
  }
}

export function msSetPosition(durationSec: number, positionSec: number, playing: boolean): void {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return
  const position = Math.max(0, Math.min(positionSec, durationSec))
  const state = { duration: durationSec, position, playbackRate: playing ? 1 : 0 }
  if (hasWebMS && navigator.mediaSession.setPositionState) {
    navigator.mediaSession.setPositionState(state)
  }
  if (isNative) void MediaSession.setPositionState(state)
}
