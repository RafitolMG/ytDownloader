import type { FormatInfo } from '@/shared/api/types'
import type { CaptureMetadata } from './useCapture'

type Props = {
  meta: CaptureMetadata
  formats: FormatInfo[]
  thumbnailUrl: string | null
  selected: FormatInfo | null
  onSelect: (f: FormatInfo) => void
  selectedAudio: string | null
  onSelectAudio: (q: string) => void
}

const AUDIO_PRESETS = [
  { value: 'mp3-192', label: 'mp3 · 192', sub: 'standard' },
  { value: 'mp3-320', label: 'mp3 · 320', sub: 'high' },
  { value: 'm4a', label: 'm4a (aac)', sub: 'apple-friendly' },
  { value: 'flac', label: 'flac', sub: 'lossless' },
]

export function VideoMetadata({
  meta,
  formats,
  thumbnailUrl,
  selected,
  onSelect,
  selectedAudio,
  onSelectAudio,
}: Props) {
  return (
    <section className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-6 mb-6">
      {/* Thumbnail */}
      <div className="relative">
        <div className="relative aspect-video rounded-sm overflow-hidden border border-border bg-page-mid img-chromatic">
          {thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt=""
              className="w-full h-full object-cover"
              referrerPolicy="no-referrer"
            />
          ) : (
            <>
              <div className="absolute inset-0 bg-gradient-to-br from-violet/40 via-hot/20 to-cool/30" />
              <div className="absolute inset-0 flex items-center justify-center">
                <svg viewBox="0 0 64 64" className="w-16 h-16 text-ink-hi/90">
                  <polygon points="22,12 22,52 52,32" fill="currentColor" />
                </svg>
              </div>
            </>
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
          ⊹ thumbnail decoded ⊹
        </div>
      </div>

      {/* Metadata + formats */}
      <div className="card-vapor rounded-sm p-5">
        <div className="font-pixel text-xs text-ink-lo uppercase tracking-[0.2em] mb-2">
          // signal acquired
        </div>
        <h2 className="font-sans text-xl font-semibold text-ink-hi leading-tight mb-1">
          ⊹ {meta.title ?? 'awaiting signal…'} ⊹
        </h2>
        <div className="font-pixel text-lg text-cool mb-4">
          {meta.uploader ?? '—'}
          {meta.duration_sec ? ` • ${fmtDuration(meta.duration_sec)}` : ''}
        </div>
        <div className="font-pixel text-xs text-ink-lo uppercase tracking-[0.2em] mb-2">
          ▸ video · download as file
        </div>
        {formats.length === 0 ? (
          <div className="font-pixel text-ink-lo">no formats yet</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {formats.map((f) => (
              <button
                key={f.format_code}
                type="button"
                onClick={() => onSelect(f)}
                className={`text-left rounded-xs border px-3 py-2 transition font-pixel ${
                  selected?.format_code === f.format_code
                    ? 'border-hot bg-hot/10 text-ink-hi shadow-[var(--shadow-glow-hot)]'
                    : 'border-border text-ink-mid hover:border-cool hover:text-cool hover:shadow-[var(--shadow-glow-cool)]'
                }`}
              >
                <div className="text-xl leading-none">
                  {selected?.format_code === f.format_code ? '◆' : '◇'} {f.resolution}
                </div>
                <div className="text-sm text-ink-lo mt-1">
                  {f.ext} · {f.size_display}
                </div>
              </button>
            ))}
          </div>
        )}

        <div className="font-pixel text-xs text-ink-lo uppercase tracking-[0.2em] mt-5 mb-2">
          ♪ audio · add to library
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {AUDIO_PRESETS.map((q) => (
            <button
              key={q.value}
              type="button"
              onClick={() => onSelectAudio(q.value)}
              className={`text-left rounded-xs border px-3 py-2 transition font-pixel ${
                selectedAudio === q.value
                  ? 'border-hot bg-hot/10 text-ink-hi shadow-[var(--shadow-glow-hot)]'
                  : 'border-border text-ink-mid hover:border-cool hover:text-cool hover:shadow-[var(--shadow-glow-cool)]'
              }`}
            >
              <div className="text-lg leading-none">
                {selectedAudio === q.value ? '◆' : '◇'} {q.label}
              </div>
              <div className="text-sm text-ink-lo mt-1">{q.sub}</div>
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
