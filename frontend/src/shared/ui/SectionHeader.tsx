import type { ReactNode } from 'react'

/** Section divider: a pixel-font title, an optional sublabel, a rule that fills
 *  the row, and an optional action node on the right. Covers the catalog/albums
 *  ("note" before the rule) and stats ("action" after it) variants in one. */
export function SectionHeader({
  title,
  note,
  action,
}: {
  title: string
  note?: string
  action?: ReactNode
}) {
  return (
    <div className="mb-3 flex items-center gap-3">
      <span className="font-pixel text-xs text-cool uppercase tracking-[0.2em] whitespace-nowrap">
        {title}
      </span>
      {note && (
        <span className="font-pixel text-xs text-ink-lo truncate">{note}</span>
      )}
      <span className="flex-1 border-t border-border" />
      {action}
    </div>
  )
}
