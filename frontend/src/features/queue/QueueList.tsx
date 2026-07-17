import { useState } from 'react'
import { JobRow } from '@/features/queue/JobRow'
import { ACTIVE_STATUSES } from '@/shared/api/types'
import { useJobs } from '@/shared/api/useJobs'

type Filter = 'all' | 'active' | 'done' | 'error'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'all' },
  { key: 'active', label: 'active' },
  { key: 'done', label: 'done' },
  { key: 'error', label: 'broken' },
]

/** The filterable job list, with no page chrome — shared by the standalone
 * /queue route and the header drawer so they never drift apart. */
export function QueueList() {
  const [filter, setFilter] = useState<Filter>('all')
  // Live progress comes via WebSocket per-row; the list refresh just needs to
  // catch new jobs and terminal transitions, so a 5s heartbeat is plenty.
  const jobsQuery = useJobs({ refetchInterval: 5_000 })
  const jobs = jobsQuery.data ?? []

  const filtered = jobs.filter((j) => {
    if (filter === 'all') return true
    if (filter === 'active') return ACTIVE_STATUSES.includes(j.status)
    if (filter === 'done') return j.status === 'done'
    if (filter === 'error') return j.status === 'error' || j.status === 'interrupted'
    return true
  })

  return (
    <div>
      <div className="flex gap-2 mb-4 flex-wrap">
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

      {jobsQuery.isLoading && (
        <div className="font-pixel text-ink-mid">// loading history…</div>
      )}

      {jobsQuery.isError && jobs.length === 0 && (
        <div className="card-vapor rounded-sm p-8 text-center font-pixel text-crit">
          <div className="text-2xl mb-2">⚠</div>
          <div>
            couldn't load the queue:{' '}
            {jobsQuery.error instanceof Error ? jobsQuery.error.message : 'unknown'}
          </div>
        </div>
      )}

      {!jobsQuery.isLoading && !jobsQuery.isError && filtered.length === 0 && (
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
    </div>
  )
}
