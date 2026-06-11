import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api, wsUrl } from '@/shared/api/client'
import type {
  FormatInfo,
  JobStatus,
  PlaylistTrack,
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

// Programmatic anchor-click is more reliable than `window.location.href`:
// setting `location.href` is treated as a navigation that the browser may
// silently cancel (popup blockers, race with React re-renders, reverse
// proxies that strip Content-Disposition). The `download` attribute on a
// same-origin <a> guarantees the response is saved as a file.
function triggerFileDownload(url: string, suggestedName: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = suggestedName
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export function useCapture() {
  const queryClient = useQueryClient()
  const [url, setUrl] = useState('')
  // The URL last analyzed successfully. Diverges from `url` while the user is
  // typing something new in the input — the page uses that divergence to hide
  // the previous video's metadata so it doesn't bleed through the dropdown.
  const [committedUrl, setCommittedUrl] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const [formats, setFormats] = useState<FormatInfo[]>([])
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null)
  const [meta, setMeta] = useState<CaptureMetadata>(EMPTY_META)
  const [playlistTracks, setPlaylistTracks] = useState<PlaylistTrack[]>([])
  /** True when the analyzed single video is detected as music (drives whether
   * the library option is offered — non-music audio downloads only run via
   * the file-download flow). Defaults true so playlists and pre-analyze
   * states don't accidentally hide controls. */
  const [isMusic, setIsMusic] = useState(true)

  const [selectedFormat, setSelectedFormat] = useState<FormatInfo | null>(null)
  // Mutually exclusive with selectedFormat — picking one clears the other.
  // When `audioMode === 'library'` the download is routed through the
  // library import flow; `'file'` produces a downloadable audio file.
  // Library mode always uses mp3-320 (the catalog's canonical bitrate);
  // file mode honours whatever preset the user picks.
  const [selectedAudio, setSelectedAudio] = useState<string | null>(null)
  const [audioMode, setAudioMode] = useState<'library' | 'file'>('library')
  // Playlist target: 'import' goes into the shared library (always mp3-320),
  // 'zip' bundles every track into one downloadable archive at the chosen
  // quality.
  const [playlistMode, setPlaylistMode] = useState<'import' | 'zip'>('import')
  const [playlistQuality, setPlaylistQuality] = useState('mp3-320')
  /** True after a `done` event whose `filename` was null — meaning the job
   * landed in the library rather than producing a downloadable file. Drives
   * the "view library" CTA on the capture page. */
  const [completedAsImport, setCompletedAsImport] = useState(false)
  /** Summary numbers from the final `done` event of a playlist/library import.
   * `skipped` covers tracks the backend couldn't resolve (unavailable, private,
   * region-locked) — surfaced in the CTA so the user knows the count. */
  const [importSummary, setImportSummary] = useState<{
    imported: number
    reused: number
    skipped: number
  } | null>(null)

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
    setPlaylistTracks([])
    setIsMusic(true)
    setSelectedFormat(null)
    setSelectedAudio(null)
    setAudioMode('library')
    setPlaylistMode('import')
    setPlaylistQuality('mp3-320')
    setCompletedAsImport(false)
    setImportSummary(null)
    setCommittedUrl('')
    setJobId(null)
    setStatus(null)
    setProgress(0)
    setTrackInfo(null)
    wsRef.current?.close()
    wsRef.current = null
  }, [])

  const analyze = useCallback(async (overrideUrl?: string) => {
    const target = (overrideUrl ?? url).trim()
    if (!target) return
    setPhase('analyzing')
    setErrorMsg(null)
    try {
      const res: ResolutionsResponse = await api.resolutions(target)
      if ('is_playlist' in res && res.is_playlist) {
        setMeta({
          ...EMPTY_META,
          is_playlist: true,
          playlist_title: res.title,
          playlist_count: res.count,
          thumbnail_url: res.thumbnail_url ?? null,
        })
        setPlaylistTracks(res.tracks ?? [])
        setThumbnailUrl(res.thumbnail_url ?? null)
        setFormats([])
        setIsMusic(true)
        setCommittedUrl(target)
        setPhase('ready')
      } else if ('formats' in res) {
        setFormats(res.formats)
        setThumbnailUrl(res.thumbnail_url ?? null)
        setMeta({ ...EMPTY_META })
        setPlaylistTracks([])
        setIsMusic(res.is_music)
        setSelectedFormat(res.formats[0] ?? null)
        // Non-music videos can't go to library — default the audio mode to
        // file so that if the user does pick an audio preset, it downloads
        // as a file instead of polluting the library.
        if (!res.is_music) {
          setAudioMode('file')
        }
        setCommittedUrl(target)
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
      const ws = new WebSocket(wsUrl(`/ws/progress/${id}`))
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
          case 'track_skipped':
            // Backend reports a per-track failure but keeps the playlist
            // running. We don't show each one inline — the final `done`
            // event aggregates them as `skipped`.
            break
          case 'done':
            setStatus('done')
            setProgress(100)
            setPhase('done')
            queryClient.invalidateQueries({ queryKey: ['jobs'] })
            queryClient.invalidateQueries({ queryKey: ['library'] })
            // Video downloads still produce a file the user must save.
            // Library imports (playlist + single-video audio without `as_file`)
            // emit `filename: null` — the page surfaces a "View library" CTA
            // instead of a browser download.
            if (data.filename) {
              triggerFileDownload(api.fileUrl(id), data.filename)
            } else {
              setCompletedAsImport(true)
              setImportSummary({
                imported: data.imported ?? 0,
                reused: data.reused ?? 0,
                skipped: data.skipped ?? 0,
              })
            }
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
        setCompletedAsImport(false)
        const asFile = playlistMode === 'zip'
        const { job_id } = await api.downloadPlaylist(url.trim(), {
          // Library imports always use mp3-320 server-side; for the zip
          // path the user picks via `playlistQuality`.
          quality: asFile ? playlistQuality : 'mp3-320',
          as_file: asFile,
        })
        setJobId(job_id)
        subscribeWs(job_id)
        queryClient.invalidateQueries({ queryKey: ['jobs'] })
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : String(e))
        setPhase('error')
      }
      return
    }
    if (!selectedFormat && !selectedAudio) return
    try {
      setPhase('downloading')
      setStatus('queued')
      setProgress(0)
      setCompletedAsImport(false)
      const payload = selectedAudio
        ? {
            url: url.trim(),
            // Library is locked to mp3-320 regardless of what's selected;
            // file mode honours the user's choice.
            format_code: audioMode === 'library' ? 'mp3-320' : selectedAudio,
            as_file: audioMode === 'file',
          }
        : {
            url: url.trim(),
            format_code: selectedFormat!.format_code,
            resolution: selectedFormat!.resolution,
            ext: selectedFormat!.ext,
          }
      const { job_id } = await api.download(payload)
      setJobId(job_id)
      subscribeWs(job_id)
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
      setPhase('error')
    }
  }, [audioMode, meta.is_playlist, playlistMode, playlistQuality, queryClient, selectedAudio, selectedFormat, subscribeWs, url])

  const abort = useCallback(async () => {
    if (!jobId) return
    try {
      await api.cancel(jobId)
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
    }
  }, [jobId])

  useEffect(() => () => wsRef.current?.close(), [])

  // Selection helpers that keep video format and audio preset mutually
  // exclusive — picking one always clears the other.
  const selectFormat = useCallback((f: FormatInfo) => {
    setSelectedFormat(f)
    setSelectedAudio(null)
  }, [])
  const selectAudio = useCallback((q: string, mode: 'library' | 'file' = 'library') => {
    setSelectedAudio(q)
    setAudioMode(mode)
    setSelectedFormat(null)
  }, [])

  return {
    url,
    setUrl,
    committedUrl,
    phase,
    errorMsg,
    formats,
    thumbnailUrl,
    meta,
    playlistTracks,
    selectedFormat,
    selectedAudio,
    audioMode,
    isMusic,
    selectFormat,
    selectAudio,
    playlistMode,
    setPlaylistMode,
    playlistQuality,
    setPlaylistQuality,
    status,
    progress,
    trackInfo,
    completedAsImport,
    importSummary,
    analyze,
    startDownload,
    abort,
    reset,
  }
}
