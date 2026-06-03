import { useQuery } from '@tanstack/react-query'
import { api } from './client'
import { ACTIVE_STATUSES, type JobRow } from './types'

export function useJobs(opts?: { refetchInterval?: number }) {
  return useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.jobs().then((r) => r.jobs),
    refetchInterval: opts?.refetchInterval ?? 4_000,
  })
}

export function countActive(jobs: JobRow[] | undefined): number {
  if (!jobs) return 0
  return jobs.filter((j) => ACTIVE_STATUSES.includes(j.status)).length
}
