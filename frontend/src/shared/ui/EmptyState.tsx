import { Link } from 'react-router-dom'

/**
 * Shared empty / first-run panel. Replaces the bare "no X yet" text scattered
 * across pages with a consistent, on-brand card that can point the user at the
 * bootstrapping action.
 */
export function EmptyState({
  glyph = '⊹',
  title,
  hint,
  cta,
}: {
  glyph?: string
  title: string
  hint?: string
  cta?: { to: string; label: string }
}) {
  return (
    <div className="card-vapor rounded-sm p-8 text-center">
      <div className="font-pixel text-lg text-ink-mid mb-2">
        {glyph} {title} {glyph}
      </div>
      {hint && <div className="font-pixel text-sm text-ink-lo">{hint}</div>}
      {cta && (
        <Link
          to={cta.to}
          className="inline-block mt-4 font-pixel text-sm uppercase tracking-widest px-4 py-1.5 border border-hot bg-hot/10 text-ink-hi shadow-[var(--shadow-glow-hot)] hover:bg-hot/20 transition rounded-xs"
        >
          {cta.label}
        </Link>
      )}
    </div>
  )
}
