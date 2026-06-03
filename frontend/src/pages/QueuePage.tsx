import { useState } from 'react'
import { AppHeader } from '@/shared/ui/AppHeader'
import { JobRow } from '@/features/queue/JobRow'
import { ACTIVE_STATUSES } from '@/shared/api/types'
import { countActive, useJobs } from '@/shared/api/useJobs'

type Filter = 'all' | 'active' | 'done' | 'error'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'all' },
  { key: 'active', label: 'active' },
  { key: 'done', label: 'done' },
  { key: 'error', label: 'broken' },
]

export default function QueuePage() {
  const [filter, setFilter] = useState<Filter>('all')
  const jobsQuery = useJobs({ refetchInterval: 2_000 })
  const jobs = jobsQuery.data ?? []
  const activeCount = countActive(jobs)

  const filtered = jobs.filter((j) => {
    if (filter === 'all') return true
    if (filter === 'active') return ACTIVE_STATUSES.includes(j.status)
    if (filter === 'done') return j.status === 'done'
    if (filter === 'error') return j.status === 'error' || j.status === 'interrupted'
    return true
  })

  return (
    <div className="relative z-10 min-h-full">
      <main className="max-w-5xl mx-auto px-6 py-8">
        <AppHeader queueCount={activeCount} />

        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div className="font-pixel text-xs text-ink-lo uppercase tracking-[0.2em]">
            ░▒▓ event log ▓▒░
          </div>
          <div className="flex gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={`font-pixel text-sm uppercase tracking-widest px-3 py-1 border rounded-xs transition ${
                  filter === f.key
                    ? 'border-cool text-cool shadow-[var(--shadow-glow-cool)]'
                    : 'border-border text-ink-mid hover:border-cool/60'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {jobsQuery.isLoading && (
          <div className="font-pixel text-ink-mid">// loading history…</div>
        )}

        {!jobsQuery.isLoading && filtered.length === 0 && (
          <div className="card-vapor rounded-sm p-8 text-center font-pixel text-ink-mid">
            <div className="text-2xl mb-2">∅</div>
            <div>no jobs match the filter</div>
          </div>
        )}

        <div className="space-y-3">
          {filtered.map((j) => (
            <JobRow key={j.id} job={j} />
          ))}
        </div>

        <footer className="mt-12 text-center font-pixel text-sm text-ink-lo">
          ＲＥＴＲＯ ＷＡＶＥ · powered by yt-dlp &amp; ffmpeg
        </footer>
      </main>
    </div>
  )
}
