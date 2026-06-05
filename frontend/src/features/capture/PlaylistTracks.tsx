import type { PlaylistTrack } from '@/shared/api/types'
import type { CaptureMetadata } from './useCapture'

type Props = {
  meta: CaptureMetadata
  tracks: PlaylistTrack[]
  thumbnailUrl: string | null
  quality: string
  onQualityChange: (q: string) => void
}

const AUDIO_QUALITIES = [
  { value: 'mp3-192', label: 'mp3 · 192', sub: 'standard' },
  { value: 'mp3-320', label: 'mp3 · 320', sub: 'high' },
  { value: 'm4a', label: 'm4a (aac)', sub: 'apple-friendly' },
  { value: 'flac', label: 'flac', sub: 'lossless' },
]

export function PlaylistTracks({
  meta,
  tracks,
  thumbnailUrl,
  quality,
  onQualityChange,
}: Props) {
  return (
    <section className="mb-6 space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-6">
        {/* Cover */}
        <div>
          <div className="relative aspect-video rounded-sm overflow-hidden border border-border bg-page-mid img-chromatic">
            {thumbnailUrl ? (
              <img
                src={thumbnailUrl}
                alt=""
                className="w-full h-full object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="absolute inset-0 bg-gradient-to-br from-violet/40 via-hot/20 to-cool/30" />
            )}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                backgroundImage:
                  'repeating-linear-gradient(to bottom, transparent 0px, transparent 2px, rgba(0,0,0,0.25) 2px, rgba(0,0,0,0.25) 3px)',
              }}
            />
          </div>
          <div className="mt-2 font-pixel text-sm text-ink-lo text-center">
            ⊹ playlist cover ⊹
          </div>
        </div>

        {/* Header + quality */}
        <div className="card-vapor rounded-sm p-5">
          <div className="font-pixel text-xs text-ink-lo uppercase tracking-[0.2em] mb-2">
            // playlist acquired
          </div>
          <h2 className="font-sans text-xl font-semibold text-ink-hi leading-tight mb-1">
            ⊹ {meta.playlist_title ?? 'Playlist detected'} ⊹
          </h2>
          <div className="font-pixel text-lg text-cool mb-4">
            {meta.playlist_count != null
              ? `${meta.playlist_count} track${meta.playlist_count === 1 ? '' : 's'}`
              : 'preparing tracks…'}
          </div>
          <div className="font-pixel text-xs text-ink-lo uppercase tracking-[0.2em] mb-2">
            audio quality
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {AUDIO_QUALITIES.map((q) => (
              <button
                key={q.value}
                type="button"
                onClick={() => onQualityChange(q.value)}
                className={`text-left rounded-xs border px-3 py-2 transition font-pixel ${
                  quality === q.value
                    ? 'border-hot bg-hot/10 text-ink-hi shadow-[var(--shadow-glow-hot)]'
                    : 'border-border text-ink-mid hover:border-cool hover:text-cool hover:shadow-[var(--shadow-glow-cool)]'
                }`}
              >
                <div className="text-lg leading-none">
                  {quality === q.value ? '◆' : '◇'} {q.label}
                </div>
                <div className="text-sm text-ink-lo mt-1">{q.sub}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Tracklist */}
      <div className="card-vapor rounded-sm">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <div className="font-pixel text-xs text-ink-lo uppercase tracking-[0.2em]">
            // tracklist
          </div>
          {meta.playlist_count != null && (
            <div className="font-pixel text-xs text-ink-lo">
              {tracks.length}/{meta.playlist_count}
            </div>
          )}
        </div>
        {tracks.length === 0 ? (
          <div className="px-4 py-6 font-pixel text-ink-lo text-center">
            ··· scanning playlist ···
          </div>
        ) : (
          <ul className="max-h-[28rem] overflow-y-auto divide-y divide-border">
            {tracks.map((t, i) => (
              <TrackRow key={t.id} track={t} index={i + 1} />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

function TrackRow({ track, index }: { track: PlaylistTrack; index: number }) {
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <div className="font-pixel text-sm text-ink-lo w-8 text-right tabular-nums">
        {String(index).padStart(2, '0')}
      </div>
      <div className="relative w-20 aspect-video flex-shrink-0 rounded-xs overflow-hidden border border-border bg-page-mid">
        {track.thumbnail ? (
          <img
            src={track.thumbnail}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-violet/40 via-hot/20 to-cool/30" />
        )}
        {track.duration_sec != null && (
          <span className="absolute bottom-0.5 right-0.5 font-pixel text-[10px] leading-none bg-page/80 text-cool px-1 py-0.5 rounded-xs">
            {fmtDuration(track.duration_sec)}
          </span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-sans text-sm font-medium text-ink-hi leading-snug line-clamp-2">
          {track.title}
        </div>
      </div>
    </li>
  )
}

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
