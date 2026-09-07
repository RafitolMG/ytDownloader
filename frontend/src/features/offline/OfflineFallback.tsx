import { useMemo } from 'react'
import { playlistRowToLibrary } from '@/shared/lib/libraryItem'
import { fmtDuration } from '@/shared/lib/format'
import { useAudioPlayer } from '@/features/player/AudioPlayerProvider'
import { useOffline } from './OfflineProvider'

/**
 * What the user can actually play right now, shown when an online view's fetch
 * fails. Sourced from the on-disk manifest rather than a cached copy of the
 * server's response: a cached catalog would list hundreds of tracks that need
 * the network to stream, which is the same "looks fine, does nothing" trap the
 * rest of this app has been getting wrong. Renders nothing when there is
 * nothing downloaded, so the caller's error message stands alone.
 */
export function OfflineFallback({ title = '▤ on this device' }: { title?: string }) {
  const off = useOffline()
  const player = useAudioPlayer()
  const rows = off.ready ? off.downloadedTracks() : []
  const items = useMemo(() => rows.map(playlistRowToLibrary), [rows])

  if (items.length === 0) return null

  return (
    <section className="mt-5">
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <div className="font-pixel text-xs text-cool uppercase tracking-[0.2em]">
          {title}
        </div>
        <button
          type="button"
          onClick={() => player.play(items, 0)}
          className="font-pixel text-xs uppercase tracking-widest px-3 py-1 border border-hot bg-hot/15 text-ink-hi shadow-[var(--shadow-glow-hot)] hover:bg-hot/25 transition rounded-xs"
        >
          ▶ play all
        </button>
        <span className="font-pixel text-xs text-ink-lo">
          {items.length} track{items.length === 1 ? '' : 's'} · playable offline
        </span>
      </div>

      <ul className="card-vapor rounded-sm divide-y divide-border">
        {items.map((t, idx) => {
          const isCurrent =
            player.current?.video_id === t.video_id &&
            player.current?.codec === t.codec
          return (
            <li
              key={`${t.video_id}/${t.codec}/${t.bitrate}`}
              role="button"
              tabIndex={0}
              aria-label={`play ${t.title ?? t.video_id}`}
              onClick={() => player.play(items, idx)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  player.play(items, idx)
                }
              }}
              className={`flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2 cursor-pointer transition ${
                isCurrent ? 'bg-hot/10' : 'hover:bg-violet/10'
              }`}
            >
              <div className="font-pixel text-xs sm:text-sm text-ink-lo w-6 sm:w-8 text-right tabular-nums">
                {isCurrent && player.isPlaying ? (
                  <span className="text-hot">▶</span>
                ) : (
                  String(idx + 1).padStart(2, '0')
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-sans text-sm font-medium text-ink-hi leading-snug truncate">
                  {t.title ?? t.video_id}
                </div>
                <div className="text-sm text-ink-lo truncate mt-0.5">
                  {t.artist ?? '—'}
                </div>
              </div>
              {t.duration_sec != null && (
                <div className="font-pixel text-xs text-ink-lo tabular-nums">
                  {fmtDuration(t.duration_sec)}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
