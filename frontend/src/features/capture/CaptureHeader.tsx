import { ChromaticTitle } from '@/shared/ui/ChromaticTitle'

export function CaptureHeader({ queueCount }: { queueCount: number }) {
  const dotColor = queueCount > 0 ? 'bg-hot' : 'bg-cool'
  const dotGlow = queueCount > 0 ? 'var(--color-hot)' : 'var(--color-cool)'
  const label = queueCount === 1 ? '1 in queue' : `${queueCount} in queue`
  return (
    <header className="flex items-center justify-between border-b border-border/60 pb-4 mb-8">
      <div className="flex items-baseline gap-3 vhs-tracking">
        <ChromaticTitle className="text-3xl md:text-4xl">YTDL</ChromaticTitle>
        <span className="font-pixel text-2xl text-cool">· 1989</span>
      </div>

      <div className="flex items-center gap-2 font-pixel text-xl text-ink-mid">
        <span
          className={`inline-block w-2 h-2 rounded-full ${dotColor}`}
          style={{ boxShadow: `0 0 8px ${dotGlow}` }}
        />
        <span>{label}</span>
      </div>
    </header>
  )
}
