/**
 * In-memory index of tracks downloaded to the device, read SYNCHRONOUSLY by the
 * audio player so playback can prefer a local file without any async hop or
 * React-context ordering coupling. The OfflineProvider is the sole writer (it
 * hydrates this from the on-disk manifest on mount and keeps it in step as
 * downloads come and go); everything else only reads.
 *
 * Always empty on the web (the provider never populates it there), so the
 * offline-first checks downstream are transparent no-ops off-native.
 */

type Entry = { audioUrl: string; coverUrl: string | null }

const byTrack = new Map<string, Entry>()
// videoId → a downloaded cover URL for it. getCover is called per-row per-render
// (PlayerBar/queue/rows), so keep it O(1) here instead of scanning byTrack each
// time. The cover is per-video (same across a video's codec/bitrate copies).
const coverByVideo = new Map<string, string>()
const subscribers = new Set<() => void>()

function key(videoId: string, codec: string, bitrate: string): string {
  return `${videoId}|${codec}|${bitrate}`
}

function emit(): void {
  for (const cb of subscribers) cb()
}

export const offlineIndex = {
  /** Local `convertFileSrc` audio URL for a track, or null if not downloaded. */
  get(videoId: string, codec: string, bitrate: string): string | null {
    return byTrack.get(key(videoId, codec, bitrate))?.audioUrl ?? null
  },

  /** Local cover URL for any downloaded copy of this video, or null. O(1). */
  getCover(videoId: string): string | null {
    return coverByVideo.get(videoId) ?? null
  },

  has(videoId: string, codec: string, bitrate: string): boolean {
    return byTrack.has(key(videoId, codec, bitrate))
  },

  set(
    videoId: string,
    codec: string,
    bitrate: string,
    audioUrl: string,
    coverUrl: string | null,
  ): void {
    byTrack.set(key(videoId, codec, bitrate), { audioUrl, coverUrl })
    if (coverUrl) coverByVideo.set(videoId, coverUrl)
    emit()
  },

  remove(videoId: string, codec: string, bitrate: string): void {
    if (!byTrack.delete(key(videoId, codec, bitrate))) return
    // Rebuild this video's cover from any remaining copy (remove is rare, so the
    // scan over the few same-video entries is fine — the hot path is getCover).
    const prefix = `${videoId}|`
    let cover: string | null = null
    for (const [k, v] of byTrack) {
      if (k.startsWith(prefix) && v.coverUrl) {
        cover = v.coverUrl
        break
      }
    }
    if (cover) coverByVideo.set(videoId, cover)
    else coverByVideo.delete(videoId)
    emit()
  },

  clear(): void {
    byTrack.clear()
    coverByVideo.clear()
    emit()
  },

  /** Subscribe to any mutation; returns an unsubscribe fn. */
  subscribe(cb: () => void): () => void {
    subscribers.add(cb)
    return () => {
      subscribers.delete(cb)
    }
  },
}
