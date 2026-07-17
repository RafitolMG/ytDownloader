import { fmtDuration } from '@/shared/lib/format'

type CardData = {
  title: string | null
  channel: string | null
  thumbnail: string | null
  duration_seconds: number | null
}

type Props = {
  data: CardData
  onSelect: () => void
}

export function SearchResultCard({ data, onSelect }: Props) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group text-left card-vapor rounded-sm overflow-hidden border border-border hover:border-cool hover:shadow-[var(--shadow-glow-cool)] transition"
    >
      <div className="relative aspect-video bg-page-mid img-chromatic">
        {data.thumbnail ? (
          <img
            src={data.thumbnail}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
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
        {data.duration_seconds != null && (
          <span className="absolute bottom-2 right-2 font-pixel text-sm bg-page/80 text-cool px-2 py-0.5 rounded-xs border border-border">
            {fmtDuration(data.duration_seconds)}
          </span>
        )}
      </div>
      <div className="p-3">
        <div className="font-sans text-sm font-semibold text-ink-hi leading-snug line-clamp-2 group-hover:text-cool transition">
          {data.title ?? '(untitled)'}
        </div>
        <div className="font-pixel text-sm text-ink-mid mt-1 truncate">
          {data.channel ?? '—'}
        </div>
      </div>
    </button>
  )
}
