/** Header button that opens the queue drawer. Shows a live count of active
 * jobs when there are any — the queue's only persistent signal now that it
 * isn't a top-level nav tab. Pulses while work is in flight. */
export function QueueIndicator({
  count,
  onClick,
}: {
  count: number
  onClick: () => void
}) {
  const active = count > 0
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={active ? `download queue, ${count} active` : 'download queue'}
      title="download queue"
      className={`font-pixel text-base md:text-lg uppercase tracking-widest px-2 md:px-3 py-1 rounded-xs border transition flex items-center gap-1.5 ${
        active
          ? 'border-cool text-cool bg-cool/10 shadow-[var(--shadow-glow-cool)]'
          : 'border-border text-ink-mid hover:text-cool hover:border-cool/70'
      }`}
    >
      <span className={active ? 'animate-pulse' : ''}>☉</span>
      {active && <span className="text-sm tabular-nums">·{count}</span>}
    </button>
  )
}
