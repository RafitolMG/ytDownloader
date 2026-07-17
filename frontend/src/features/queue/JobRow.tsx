import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/shared/api/client'
import type { JobRow as Job, JobStatus } from '@/shared/api/types'
import { ConfirmButton } from '@/shared/ui/ConfirmButton'
import { useLiveJobProgress } from './useLiveJobProgress'

const STATUS_STYLES: Record<JobStatus, { label: string; cls: string; glow?: string }> = {
  queued:      { label: 'queued',      cls: 'text-ink-mid border-ink-lo/40' },
  downloading: { label: 'downloading', cls: 'text-cool border-cool/60',     glow: 'var(--color-cool)' },
  merging:     { label: 'merging',     cls: 'text-sun border-sun/60',       glow: 'var(--color-sun)' },
  transcoding: { label: 'transcoding', cls: 'text-violet border-violet/60', glow: 'var(--color-violet)' },
  done:        { label: 'done',        cls: 'text-cool border-cool/60' },
  error:       { label: 'error',       cls: 'text-crit border-crit/60',     glow: 'var(--color-crit)' },
  interrupted: { label: 'interrupted', cls: 'text-sun border-sun/60' },
  cancelled:   { label: 'cancelled',   cls: 'text-ink-lo border-ink-lo/40' },
}

function buildBar(pct: number, width = 18) {
  const safe = Math.max(0, Math.min(100, pct))
  const filled = Math.round((safe / 100) * width)
  return '▓'.repeat(filled) + '░'.repeat(width - filled)
}

function fmtBytes(n: number | null): string {
  if (!n) return '—'
  const mb = n / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  return `${mb.toFixed(1)} MB`
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

export function JobRow({ job }: { job: Job }) {
  const qc = useQueryClient()
  const invalidate = () => qc.invalidateQueries({ queryKey: ['jobs'] })

  const cancel = useMutation({ mutationFn: () => api.cancel(job.id), onSuccess: invalidate })
  const retry = useMutation({ mutationFn: () => api.retry(job.id), onSuccess: invalidate })
  const del = useMutation({ mutationFn: () => api.delete(job.id), onSuccess: invalidate })

  const active = job.status === 'queued' || job.status === 'downloading' || job.status === 'merging' || job.status === 'transcoding'
  // Live overlay only when the job is active — closed sockets reset their
  // local state so finished jobs don't keep showing stale per-track info.
  const live = useLiveJobProgress(job.id, active)
  const displayStatus: JobStatus = live.status ?? job.status
  const displayProgress = live.progress ?? job.progress_pct
  const style = STATUS_STYLES[displayStatus]
  const title = job.title ?? job.playlist_title ?? job.url

  return (
    <div className="card-vapor rounded-sm p-3 sm:p-4 grid grid-cols-[60px_1fr] sm:grid-cols-[80px_1fr_auto] gap-3 sm:gap-4 items-center">
      {/* Thumbnail */}
      <div className="relative aspect-video rounded-xs overflow-hidden border border-border/60 bg-page-mid">
        {job.thumbnail_url ? (
          <img
            src={job.thumbnail_url}
            alt=""
            className="w-full h-full object-cover img-chromatic"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-violet/30 to-hot/20" />
        )}
      </div>

      {/* Main info */}
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span
            className={`font-pixel uppercase text-xs tracking-widest px-2 py-px border rounded-xs ${style.cls}`}
            style={style.glow ? { boxShadow: `0 0 10px ${style.glow}` } : undefined}
          >
            {style.label}
          </span>
          {job.is_playlist === 1 && (
            <span className="font-pixel uppercase text-xs tracking-widest px-2 py-px border border-violet/60 text-violet rounded-xs">
              playlist {job.playlist_count ? `· ${job.playlist_count}` : ''}
            </span>
          )}
          <span className="font-pixel text-sm text-ink-lo">{fmtDate(job.created_at)}</span>
        </div>

        <div className="font-sans text-base text-ink-hi truncate">{title}</div>
        <div className="font-pixel text-sm text-ink-mid truncate">
          {[job.uploader, job.resolution || job.format_code, job.ext, fmtBytes(job.size_bytes)]
            .filter(Boolean)
            .join(' · ')}
        </div>

        {active ? (
          <>
            <div className="font-pixel text-lg mt-2">
              <span className="text-cool">{buildBar(displayProgress)}</span>{' '}
              <span className="text-hot">{displayProgress.toFixed(1)}%</span>
            </div>
            {live.track && (
              <div className="font-pixel text-sm text-ink-mid mt-1 truncate">
                <span className="text-cool tabular-nums">
                  {live.track.index}/{live.track.total}
                </span>{' '}
                · <span className="text-ink-hi">{live.track.title}</span>
              </div>
            )}
            {live.skipped > 0 && (
              <div className="font-pixel text-sm text-sun mt-1">
                ⚠ {live.skipped} skipped
              </div>
            )}
          </>
        ) : job.status === 'error' && job.error_message ? (
          <div className="font-pixel text-sm text-crit/80 mt-1 truncate" title={job.error_message}>
            ⚠ {job.error_message}
          </div>
        ) : null}
      </div>

      {/* Actions — span both cols on mobile so they sit beneath the meta;
          on sm+ they live in the third column. */}
      <div className="col-span-2 sm:col-span-1 flex flex-row sm:flex-col gap-2 items-stretch">
        {active ? (
          <button
            type="button"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
            className="font-pixel text-sm uppercase tracking-widest px-3 py-1 border border-crit/60 text-crit hover:bg-crit/10 disabled:opacity-40 transition rounded-xs"
          >
            ✕ abort
          </button>
        ) : (
          <>
            <button
              type="button"
              disabled={retry.isPending}
              onClick={() => retry.mutate()}
              className="font-pixel text-sm uppercase tracking-widest px-3 py-1 border border-cool/60 text-cool hover:bg-cool/10 hover:shadow-[var(--shadow-glow-cool)] disabled:opacity-40 transition rounded-xs"
            >
              ↻ retry
            </button>
            <ConfirmButton
              onConfirm={() => del.mutate()}
              disabled={del.isPending}
              idle="⌫ delete"
              title="delete this job from history"
            />
          </>
        )}
      </div>
    </div>
  )
}
