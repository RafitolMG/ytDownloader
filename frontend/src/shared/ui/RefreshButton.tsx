/** "↻ refresh" control for re-rolling a rotating feed (suggestions carousel,
 *  radio's "more like this"); the glyph spins and the button locks while busy. */
export function RefreshButton({
  onClick,
  busy = false,
  label = 'refresh',
  title = 'show a different set',
}: {
  onClick: () => void
  busy?: boolean
  label?: string
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title={title}
      aria-label={title}
      aria-busy={busy}
      className="font-pixel text-xs uppercase tracking-widest px-2 py-1 border border-border text-ink-lo hover:text-cool hover:border-cool/70 transition rounded-xs disabled:opacity-60 disabled:cursor-wait inline-flex items-center gap-1.5 whitespace-nowrap"
    >
      <span className={busy ? 'inline-block animate-spin' : 'inline-block'} aria-hidden>
        ↻
      </span>
      {label}
    </button>
  )
}
