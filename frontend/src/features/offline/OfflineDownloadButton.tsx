import { useState } from 'react'
import type { PlaylistTrackRow } from '@/shared/api/types'
import { useOffline } from './OfflineProvider'

/** Download every track of a collection (playlist or album) to the device for
 *  offline playback — native only. Idle → progress → "✓ offline" with a two-step
 *  remove. Keyed on an arbitrary stable `id`: real playlist ids for playlists,
 *  a synthetic `album:<key>` for albums. Renders nothing off-native. */
export function OfflineDownloadButton({
  id,
  name,
  tracks,
}: {
  id: string
  name: string
  tracks: PlaylistTrackRow[]
}) {
  const off = useOffline()
  const [armedRemove, setArmedRemove] = useState(false)

  if (!off.supported) return null

  // Previews aren't real DB tracks — they can't be streamed offline.
  const real = tracks.filter((t) => t.codec !== 'preview')
  const total = real.length
  if (total === 0) return null

  const progress = off.progressFor(id)
  if (progress) {
    return (
      <span className="font-pixel text-sm uppercase tracking-widest px-4 py-1 border border-cool/60 text-cool rounded-xs">
        ··· {progress.done}/{progress.total}
      </span>
    )
  }

  const done = real.filter((t) =>
    off.isDownloaded(t.video_id, t.codec, t.bitrate),
  ).length

  if (done === total) {
    if (armedRemove) {
      return (
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              void off.removePlaylist(id)
              setArmedRemove(false)
            }}
            title="confirm — delete downloaded files"
            className="font-pixel text-sm uppercase tracking-widest px-2 py-1 border border-crit/60 text-crit bg-crit/10 hover:bg-crit/20 transition rounded-xs"
          >
            ⚠ remove
          </button>
          <button
            type="button"
            onClick={() => setArmedRemove(false)}
            title="cancel"
            className="font-pixel text-sm uppercase tracking-widest px-2 py-1 border border-border text-ink-lo hover:text-cool transition rounded-xs"
          >
            ✕
          </button>
        </span>
      )
    }
    return (
      <button
        type="button"
        onClick={() => setArmedRemove(true)}
        title="downloaded for offline — tap to remove"
        className="font-pixel text-sm uppercase tracking-widest px-4 py-1 border border-cool bg-cool/10 text-cool shadow-[var(--shadow-glow-cool)] hover:bg-cool/20 transition rounded-xs"
      >
        ✓ offline
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={() => void off.downloadPlaylist(id, name, tracks)}
      title="download for offline playback"
      className="font-pixel text-sm uppercase tracking-widest px-4 py-1 border border-cool/60 text-cool hover:bg-cool/10 transition rounded-xs"
    >
      ⬇ {done > 0 ? `${done}/${total}` : 'download'}
    </button>
  )
}
