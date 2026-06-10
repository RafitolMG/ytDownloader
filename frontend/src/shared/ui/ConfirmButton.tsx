import { useState } from 'react'
import { G } from './glyphs'

/**
 * Two-step destructive button: first click arms it (flips to a ⚠ confirm /
 * ✕ cancel pair), second click fires `onConfirm`. No native window.confirm —
 * matches the app's themed, in-place confirmation pattern. Shared by the admin
 * console (job/track deletes) and playlist delete.
 */
export function ConfirmButton({
  onConfirm,
  disabled,
  idle,
  title,
}: {
  onConfirm: () => void
  disabled?: boolean
  /** Resting label, e.g. "✕ del" or "✕ delete playlist". */
  idle: string
  title?: string
}) {
  const [armed, setArmed] = useState(false)

  if (armed) {
    return (
      <span className="flex items-center gap-1">
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            onConfirm()
            setArmed(false)
          }}
          title="confirm"
          className="font-pixel text-xs uppercase tracking-widest px-2 py-1 border border-crit/60 text-crit bg-crit/10 hover:bg-crit/20 transition rounded-xs disabled:opacity-40"
        >
          {G.warn}
        </button>
        <button
          type="button"
          onClick={() => setArmed(false)}
          title="cancel"
          className="font-pixel text-xs uppercase tracking-widest px-2 py-1 border border-border text-ink-lo hover:text-cool transition rounded-xs"
        >
          {G.close}
        </button>
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setArmed(true)}
      disabled={disabled}
      title={title}
      className="font-pixel text-xs uppercase tracking-widest px-2 py-1 border border-crit/60 text-crit hover:bg-crit/10 transition rounded-xs disabled:opacity-40"
    >
      {idle}
    </button>
  )
}
