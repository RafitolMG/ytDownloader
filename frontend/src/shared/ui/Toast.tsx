import { useEffect, useState } from 'react'

export function ErrorToast({
  message,
  onDismiss,
}: {
  message: string | null
  onDismiss?: () => void
}) {
  const [shown, setShown] = useState(false)

  useEffect(() => {
    if (!message) return
    setShown(true)
    const t = setTimeout(() => {
      setShown(false)
      onDismiss?.()
    }, 6000)
    return () => clearTimeout(t)
  }, [message, onDismiss])

  if (!message || !shown) return null

  return (
    <div
      role="alert"
      className="fixed top-6 right-6 z-50 max-w-md card-vapor rounded-sm border border-crit/70 text-ink-hi font-pixel text-lg px-4 py-3 shadow-[0_0_24px_rgba(255,77,94,0.45)]"
    >
      <div className="text-crit uppercase text-sm tracking-widest mb-1">⚠ err</div>
      <div className="break-words">{message}</div>
    </div>
  )
}
