import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { G } from './glyphs'

type ToastVariant = 'info' | 'success' | 'err'
type ToastAction = { label: string; onClick: () => void }
type Toast = {
  id: number
  message: string
  variant: ToastVariant
  action?: ToastAction
}

type ShowToast = (t: {
  message: string
  variant?: ToastVariant
  action?: ToastAction
  durationMs?: number
}) => void

const Ctx = createContext<ShowToast | null>(null)

const VARIANT: Record<ToastVariant, { border: string; label: string; glyph: string }> = {
  info: { border: 'border-cool/70', label: 'text-cool', glyph: '◈' },
  success: { border: 'border-violet/70', label: 'text-violet', glyph: G.check },
  err: { border: 'border-crit/70', label: 'text-crit', glyph: G.warn },
}

/** Lightweight, imperative toast system. `useToast()` returns a `showToast`
 * fn; toasts stack bottom-right (above the player bar) and auto-dismiss. The
 * optional `action` (e.g. undo) turns a destructive op into a recoverable one. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const idRef = useRef(0)

  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id))
  }, [])

  const showToast = useCallback<ShowToast>(
    ({ message, variant = 'info', action, durationMs = 6000 }) => {
      const id = (idRef.current += 1)
      setToasts((ts) => [...ts, { id, message, variant, action }])
      setTimeout(() => dismiss(id), durationMs)
    },
    [dismiss],
  )

  return (
    <Ctx.Provider value={showToast}>
      {children}
      <div className="fixed bottom-24 right-4 z-[70] flex flex-col gap-2 max-w-[calc(100vw-2rem)] sm:max-w-sm pointer-events-none">
        {toasts.map((t) => {
          const v = VARIANT[t.variant]
          return (
            <div
              key={t.id}
              role="status"
              className={`pointer-events-auto card-vapor rounded-sm border ${v.border} px-3 py-2 flex items-center gap-3 shadow-[var(--shadow-glow-cool)]`}
            >
              <span className={`font-pixel text-sm ${v.label}`}>{v.glyph}</span>
              <span className="font-sans text-sm text-ink-hi flex-1 min-w-0 break-words">
                {t.message}
              </span>
              {t.action && (
                <button
                  type="button"
                  onClick={() => {
                    t.action!.onClick()
                    dismiss(t.id)
                  }}
                  className="font-pixel text-xs uppercase tracking-widest px-2 py-1 border border-cool/60 text-cool hover:bg-cool/10 rounded-xs transition whitespace-nowrap"
                >
                  {G.undo} {t.action.label}
                </button>
              )}
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                title="dismiss"
                aria-label="dismiss"
                className="font-pixel text-sm text-ink-lo hover:text-crit transition"
              >
                {G.close}
              </button>
            </div>
          )
        })}
      </div>
    </Ctx.Provider>
  )
}

export function useToast(): ShowToast {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useToast must be used inside a ToastProvider')
  return ctx
}
