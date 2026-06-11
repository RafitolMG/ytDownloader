import { Capacitor } from '@capacitor/core'
import { MediaSession } from '@jofr/capacitor-media-session'
import { hiResThumbnail } from '@/shared/lib/thumbnail'

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
  // The stored thumbnail is hqdefault (480×360); upscaled onto a lock-screen /
  // notification it looks blurry. Offer the 1280×720 maxres frame first with
  // the original as a guaranteed fallback (maxres 404s for some videos), so the
  // OS picks the sharpest one that loads.
  if (!url) return []
  const hi = hiResThumbnail(url)
  const list: { src: string; sizes: string; type: string }[] = []
  if (hi && hi !== url) list.push({ src: hi, sizes: '1280x720', type: 'image/jpeg' })
  list.push({ src: url, sizes: '480x360', type: 'image/jpeg' })
  return list
}

export function msSetMetadata(m: Meta | null): void {
  if (isNative) {
    if (!m) return
    void MediaSession.setMetadata({
      title: m.title,
      artist: m.artist,
      album: m.album,
      artwork: artworkOf(m.artworkUrl),
    })
    return
  }
  if (!('mediaSession' in navigator)) return
  navigator.mediaSession.metadata = m
    ? new MediaMetadata({
        title: m.title,
        artist: m.artist,
        album: m.album,
        artwork: artworkOf(m.artworkUrl),
      })
    : null
}

export function msSetPlaybackState(state: 'playing' | 'paused' | 'none'): void {
  if (isNative) {
    void MediaSession.setPlaybackState({ playbackState: state })
    return
  }
  if (!('mediaSession' in navigator)) return
  navigator.mediaSession.playbackState = state
}

export function msSetActionHandler(action: Action, handler: (() => void) | null): void {
  if (isNative) {
    void MediaSession.setActionHandler({ action }, handler ? () => handler() : null)
    return
  }
  if (!('mediaSession' in navigator)) return
  navigator.mediaSession.setActionHandler(action, handler)
}

export function msSetPosition(durationSec: number, positionSec: number, playing: boolean): void {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return
  const position = Math.max(0, Math.min(positionSec, durationSec))
  if (isNative) {
    void MediaSession.setPositionState({
      duration: durationSec,
      position,
      playbackRate: playing ? 1 : 0,
    })
    return
  }
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return
  navigator.mediaSession.setPositionState({
    duration: durationSec,
    position,
    playbackRate: playing ? 1 : 0,
  })
}
