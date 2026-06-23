import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/shared/api/client'
import type { ExternalCatalogItem } from '@/shared/api/types'
import { useLiveJobProgress } from '@/features/queue/useLiveJobProgress'

/** Shared download lifecycle for a YouTube candidate (external row or
 * suggestion card): fire an mp3-320 library import, follow the job's progress
 * WS, and on completion invalidate the catalog views so the track re-renders
 * as a real DB row. Returns just the bits the UIs need to draw themselves. */
export function useExternalDownload(
  item: ExternalCatalogItem,
  opts: { own?: boolean } = {},
) {
  const own = opts.own ?? true
  const queryClient = useQueryClient()
  const [jobId, setJobId] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  const live = useLiveJobProgress(jobId ?? '', jobId !== null)

  const download = useMutation({
    mutationFn: () =>
      api.download({
        url: item.source_url,
        format_code: 'mp3-320',
        as_file: false,
        own,
      }),
    onSuccess: ({ job_id }) => {
      setJobId(job_id)
      setFailed(null)
    },
    onError: (e) => setFailed(e instanceof Error ? e.message : 'download failed'),
  })

  const isDone = live.status === 'done'

  useEffect(() => {
    if (isDone) {
      queryClient.invalidateQueries({ queryKey: ['discover'] })
      queryClient.invalidateQueries({ queryKey: ['catalog'] })
      // Deliberately NOT invalidating ['catalog-suggestions'] here: the
      // suggestions carousel hosts this very card, so refetching it would yank
      // the card the moment its download finishes. The card shows its own
      // "✓ added" state instead and the carousel refreshes on its own staleTime.
      queryClient.invalidateQueries({ queryKey: ['daily-mixes'] })
      queryClient.invalidateQueries({ queryKey: ['library'] })
    } else if (live.status === 'error') {
      setFailed('download failed — check the queue')
    }
  }, [isDone, live.status, queryClient])

  const started = jobId !== null
  const isPending =
    download.isPending || (started && !isDone && live.status !== 'error')

  return {
    start: () => {
      if (!isPending) download.mutate()
    },
    isPending,
    isDone,
    started,
    pct: live.progress ?? 0,
    failed,
  }
}
