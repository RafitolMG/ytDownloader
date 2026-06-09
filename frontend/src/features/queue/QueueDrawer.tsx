import { useEffect } from 'react'
import { QueueList } from './QueueList'

/** Slide-over panel holding the job queue. The queue is a transient status
 * surface, not a destination, so it lives behind the header indicator rather
 * than a top-level nav tab. */
export function QueueDrawer({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  // Close on Escape — standard for any overlay.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <>
      {/* Scrim */}
      <div
        onClick={onClose}
        aria-hidden
        className={`fixed inset-0 z-40 bg-page/70 backdrop-blur-sm transition-opacity duration-200 ${
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      />
      {/* Panel */}
      <aside
        role="dialog"
        aria-label="download queue"
        aria-modal="true"
        className={`fixed top-0 right-0 z-50 h-full w-full sm:w-[30rem] max-w-full bg-page-mid border-l border-cool/40 shadow-[var(--shadow-glow-cool)] flex flex-col transition-transform duration-200 ease-out ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <header className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-border/60">
          <div className="font-pixel text-xs text-ink-lo uppercase tracking-[0.2em]">
            ░▒▓ download queue ▓▒░
          </div>
          <button
            type="button"
            onClick={onClose}
            title="close"
            aria-label="close queue"
            className="font-pixel text-sm uppercase tracking-widest px-2 py-px border border-ink-lo/50 text-ink-lo hover:text-crit hover:border-crit/60 transition rounded-xs"
          >
            ✕
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 pb-24">
          {open && <QueueList />}
        </div>
      </aside>
    </>
  )
}
