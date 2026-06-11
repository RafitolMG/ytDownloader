import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { wsUrl } from '@/shared/api/client'
import type { JobStatus, WsEvent } from '@/shared/api/types'

/** Live overlay for an active job — subscribes to /ws/progress/{jobId} and
 * exposes the fields that update faster than the 2s polling can show. Stays
 * dormant (no socket) when `enabled` is false. */
export type LiveJobProgress = {
  progress: number | null
  status: JobStatus | null
  track: { index: number; total: number; title: string } | null
  skipped: number
}

const EMPTY: LiveJobProgress = {
  progress: null,
  status: null,
  track: null,
  skipped: 0,
}

export function useLiveJobProgress(
  jobId: string,
  enabled: boolean,
): LiveJobProgress {
  const [state, setState] = useState<LiveJobProgress>(EMPTY)
  const qc = useQueryClient()
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!enabled) {
      // Tear down any leftover subscription and reset so the row stops
      // showing stale live data once the job has settled.
      wsRef.current?.close()
      wsRef.current = null
      setState(EMPTY)
      return
    }

    const ws = new WebSocket(wsUrl(`/ws/progress/${jobId}`))
    wsRef.current = ws

    ws.onmessage = (ev) => {
      const data = JSON.parse(ev.data) as WsEvent
      switch (data.type) {
        case 'snapshot':
          setState((s) => ({
            ...s,
            progress: data.job.progress_pct,
            status: data.job.status,
          }))
          break
        case 'progress':
          setState((s) => ({ ...s, progress: data.value }))
          break
        case 'status':
          setState((s) => ({ ...s, status: data.value }))
          break
        case 'track':
          setState((s) => ({
            ...s,
            track: { index: data.index, total: data.total, title: data.title },
          }))
          break
        case 'track_skipped':
          setState((s) => ({ ...s, skipped: s.skipped + 1 }))
          break
        case 'done':
        case 'error':
        case 'cancelled':
          // The server closes the socket right after these; invalidate so the
          // polled job list picks up the terminal state immediately instead
          // of waiting for the next 2s tick.
          qc.invalidateQueries({ queryKey: ['jobs'] })
          break
      }
    }

    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null
    }

    return () => {
      ws.close()
    }
  }, [jobId, enabled, qc])

  return state
}
