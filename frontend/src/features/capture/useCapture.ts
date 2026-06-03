import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/shared/api/client'
import type {
  FormatInfo,
  JobStatus,
  ResolutionsResponse,
  WsEvent,
} from '@/shared/api/types'

type Phase = 'idle' | 'analyzing' | 'ready' | 'downloading' | 'done' | 'error'

export type CaptureMetadata = {
  title: string | null
  uploader: string | null
  thumbnail_url: string | null
  duration_sec: number | null
  is_playlist: boolean
  playlist_title: string | null
  playlist_count: number | null
}

const EMPTY_META: CaptureMetadata = {
  title: null,
  uploader: null,
  thumbnail_url: null,
  duration_sec: null,
  is_playlist: false,
  playlist_title: null,
  playlist_count: null,
}

export function useCapture() {
  const queryClient = useQueryClient()
  const [url, setUrl] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const [formats, setFormats] = useState<FormatInfo[]>([])
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null)
  const [meta, setMeta] = useState<CaptureMetadata>(EMPTY_META)

  const [selectedFormat, setSelectedFormat] = useState<FormatInfo | null>(null)
  const [playlistQuality, setPlaylistQuality] = useState('audio')

  const [jobId, setJobId] = useState<string | null>(null)
  const [status, setStatus] = useState<JobStatus | null>(null)
  const [progress, setProgress] = useState(0)
  const [trackInfo, setTrackInfo] = useState<{ index: number; total: number; title: string } | null>(null)

  const wsRef = useRef<WebSocket | null>(null)

  const reset = useCallback(() => {
    setPhase('idle')
    setErrorMsg(null)
    setFormats([])
    setThumbnailUrl(null)
    setMeta(EMPTY_META)
    setSelectedFormat(null)
    setJobId(null)
    setStatus(null)
    setProgress(0)
    setTrackInfo(null)
    wsRef.current?.close()
    wsRef.current = null
  }, [])

  const analyze = useCallback(async () => {
    if (!url.trim()) return
    setPhase('analyzing')
    setErrorMsg(null)
    try {
      const res: ResolutionsResponse = await api.resolutions(url.trim())
      if ('is_playlist' in res && res.is_playlist) {
        setMeta({ ...EMPTY_META, is_playlist: true })
        setFormats([])
        setThumbnailUrl(null)
        setPhase('ready')
      } else if ('formats' in res) {
        setFormats(res.formats)
        setThumbnailUrl(res.thumbnail_url ?? null)
        setMeta({ ...EMPTY_META })
        setSelectedFormat(res.formats[0] ?? null)
        setPhase('ready')
      } else {
        throw new Error('Unexpected /api/resolutions response.')
      }
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
      setPhase('error')
    }
  }, [url])

  const subscribeWs = useCallback(
    (id: string) => {
      const loc = window.location
      const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${proto}//${loc.host}/ws/progress/${id}`)
      wsRef.current = ws

      ws.onmessage = (ev) => {
        const data = JSON.parse(ev.data) as WsEvent
        switch (data.type) {
          case 'snapshot':
            setStatus(data.job.status)
            setProgress(data.job.progress_pct)
            if (data.job.title) {
              setMeta((m) => ({
                ...m,
                title: data.job.title,
                uploader: data.job.uploader,
                thumbnail_url: data.job.thumbnail_url,
                duration_sec: data.job.duration_sec,
              }))
              if (data.job.thumbnail_url) setThumbnailUrl(data.job.thumbnail_url)
            }
            break
          case 'metadata':
            setMeta((m) => ({
              ...m,
              title: data.title ?? m.title,
              uploader: data.uploader ?? m.uploader,
              thumbnail_url: data.thumbnail_url ?? m.thumbnail_url,
              duration_sec: data.duration_sec ?? m.duration_sec,
              playlist_title: data.playlist_title ?? m.playlist_title,
              playlist_count: data.playlist_count ?? m.playlist_count,
            }))
            if (data.thumbnail_url) setThumbnailUrl(data.thumbnail_url)
            break
          case 'progress':
            setProgress(data.value)
            setStatus((s) => s ?? 'downloading')
            break
          case 'status':
            setStatus(data.value)
            break
          case 'track':
            setTrackInfo({ index: data.index, total: data.total, title: data.title })
            break
          case 'done':
            setStatus('done')
            setProgress(100)
            setPhase('done')
            queryClient.invalidateQueries({ queryKey: ['jobs'] })
            // Trigger the browser download
            window.location.href = api.fileUrl(id)
            ws.close()
            break
          case 'error':
            setStatus('error')
            setErrorMsg(data.message)
            setPhase('error')
            queryClient.invalidateQueries({ queryKey: ['jobs'] })
            ws.close()
            break
          case 'cancelled':
            setStatus('cancelled')
            setPhase('idle')
            queryClient.invalidateQueries({ queryKey: ['jobs'] })
            ws.close()
            break
        }
      }
      ws.onerror = () => {
        setErrorMsg('lost connection to backend')
      }
    },
    [queryClient],
  )

  const startDownload = useCallback(async () => {
    if (meta.is_playlist) {
      try {
        setPhase('downloading')
        setStatus('queued')
        setProgress(0)
        const { job_id } = await api.downloadPlaylist(url.trim(), playlistQuality)
        setJobId(job_id)
        subscribeWs(job_id)
        queryClient.invalidateQueries({ queryKey: ['jobs'] })
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : String(e))
        setPhase('error')
      }
      return
    }
    if (!selectedFormat) return
    try {
      setPhase('downloading')
      setStatus('queued')
      setProgress(0)
      const { job_id } = await api.download({
        url: url.trim(),
        format_code: selectedFormat.format_code,
        resolution: selectedFormat.resolution,
        ext: selectedFormat.ext,
      })
      setJobId(job_id)
      subscribeWs(job_id)
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
      setPhase('error')
    }
  }, [meta.is_playlist, playlistQuality, queryClient, selectedFormat, subscribeWs, url])

  const abort = useCallback(async () => {
    if (!jobId) return
    try {
      await api.cancel(jobId)
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
    }
  }, [jobId])

  useEffect(() => () => wsRef.current?.close(), [])

  return {
    url,
    setUrl,
    phase,
    errorMsg,
    formats,
    thumbnailUrl,
    meta,
    selectedFormat,
    selectFormat: setSelectedFormat,
    playlistQuality,
    setPlaylistQuality,
    status,
    progress,
    trackInfo,
    analyze,
    startDownload,
    abort,
    reset,
  }
}
