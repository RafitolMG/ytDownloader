import type { JobStatus } from '@/shared/api/types'

type Props = {
  status: JobStatus | null
  progress: number
  trackInfo: { index: number; total: number; title: string } | null
  canStart: boolean
  onStart: () => void
  onAbort: () => void
}

function buildBar(pct: number, width = 24) {
  const safe = Math.max(0, Math.min(100, pct))
  const filled = Math.round((safe / 100) * width)
  return '▓'.repeat(filled) + '░'.repeat(width - filled)
}

export function DownloadProgress({
  status,
  progress,
  trackInfo,
  canStart,
  onStart,
  onAbort,
}: Props) {
  const active = status === 'queued' || status === 'downloading' || status === 'merging' || status === 'transcoding'

  return (
    <section className="card-vapor rounded-sm p-5">
      <div className="font-pixel text-xs text-ink-lo uppercase tracking-[0.2em] mb-3">
        {status === 'transcoding' ? '▶ transcoding (this is slow)' :
         status === 'merging'     ? '▶ merging' :
         active                    ? '▶ transmitting' :
         status === 'done'         ? '✓ complete' :
                                     '◆ standby'}
      </div>

      <div className="font-pixel text-2xl leading-tight">
        <div className="flex items-baseline gap-3">
          <span className="text-cool">{buildBar(progress)}</span>
          <span className="text-hot text-3xl">{progress.toFixed(1)}%</span>
        </div>
        {trackInfo && (
          <div className="text-ink-mid text-lg mt-2">
            ▸ track {trackInfo.index}/{trackInfo.total} · {trackInfo.title}
          </div>
        )}
        {!trackInfo && status && (
          <div className="text-ink-mid text-lg mt-2">▸ {status}</div>
        )}
      </div>

      <div className="mt-5 flex justify-end gap-3">
        <button
          type="button"
          disabled={!active}
          onClick={onAbort}
          className="font-pixel text-lg uppercase tracking-widest px-4 py-1 border border-crit/60 text-crit hover:bg-crit/10 hover:shadow-[0_0_18px_rgba(255,77,94,0.4)] disabled:opacity-40 disabled:cursor-not-allowed transition rounded-xs"
        >
          ✕ abort
        </button>
        <button
          type="button"
          disabled={!canStart || active}
          onClick={onStart}
          className="font-pixel text-lg uppercase tracking-widest px-5 py-1 border border-hot bg-hot/15 text-ink-hi shadow-[var(--shadow-glow-hot)] hover:bg-hot/25 disabled:opacity-40 disabled:cursor-not-allowed transition rounded-xs"
        >
          ▼ download
        </button>
      </div>
    </section>
  )
}
