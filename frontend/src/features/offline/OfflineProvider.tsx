/**
 * Owns the on-device download lifecycle: hydrates the offline index from the
 * disk manifest on mount, downloads/removes playlists, and exposes synchronous
 * lookups + per-playlist progress to the UI. The audio player reads the index
 * directly (see offlineIndex); this provider is what the playlist screen drives.
 *
 * Entirely inert off-native — `supported` is false, the index stays empty, and
 * the playlist screen hides its download button accordingly.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { api, ensureMediaToken } from '@/shared/api/client'
import type { PlaylistTrackRow } from '@/shared/api/types'
import { offlineIndex } from './offlineIndex'
import * as storage from './storage'
import type { Manifest, ManifestEntry } from './storage'

type Progress = { done: number; total: number }

type OfflineCtx = {
  supported: boolean
  ready: boolean
  totalBytes: number
  /** Truthy when a copy of this exact track is on disk. */
  isDownloaded: (videoId: string, codec: string, bitrate: string) => boolean
  /** Active download progress for a playlist, or null when idle. */
  progressFor: (playlistId: string) => Progress | null
  downloadPlaylist: (
    playlistId: string,
    playlistName: string,
    tracks: PlaylistTrackRow[],
  ) => Promise<void>
  removePlaylist: (playlistId: string) => Promise<void>
  /** Tracks downloaded for a playlist, rebuilt from the on-disk manifest — used
   *  to render the playlist with no network. Empty when nothing is downloaded. */
  offlineTracksFor: (playlistId: string) => PlaylistTrackRow[]
  /** Saved name of a downloaded playlist, or null. */
  playlistName: (playlistId: string) => string | null
}

const Ctx = createContext<OfflineCtx | null>(null)

export function OfflineProvider({ children }: { children: ReactNode }) {
  const supported = storage.isOfflineSupported()
  const manifestRef = useRef<Manifest>({ tracks: [], playlists: {} })
  const [ready, setReady] = useState(!supported)
  const [totalBytes, setTotalBytes] = useState(0)
  const [active, setActive] = useState<Record<string, Progress>>({})
  // Bumped on every index mutation so consumers calling isDownloaded re-render.
  const [, setVersion] = useState(0)

  useEffect(() => offlineIndex.subscribe(() => setVersion((v) => v + 1)), [])

  const recomputeBytes = useCallback(() => {
    setTotalBytes(
      manifestRef.current.tracks.reduce((n, e) => n + (e.bytes || 0), 0),
    )
  }, [])

  // Hydrate the index from disk once on native.
  useEffect(() => {
    if (!supported) return
    let cancelled = false
    void (async () => {
      const manifest = await storage.readManifest()
      if (cancelled) return
      manifestRef.current = manifest
      for (const e of manifest.tracks) {
        try {
          const audioUrl = await storage.toPlayableUrl(e.audioFile)
          const coverUrl = e.coverFile
            ? await storage.toPlayableUrl(e.coverFile)
            : null
          offlineIndex.set(e.video_id, e.codec, e.bitrate, audioUrl, coverUrl)
        } catch {
          // a missing file just stays absent from the index
        }
      }
      if (cancelled) return
      recomputeBytes()
      setReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [supported, recomputeBytes])

  const isDownloaded = useCallback(
    (videoId: string, codec: string, bitrate: string) =>
      offlineIndex.has(videoId, codec, bitrate),
    [],
  )

  const progressFor = useCallback(
    (playlistId: string) => active[playlistId] ?? null,
    [active],
  )

  const downloadPlaylist = useCallback(
    async (
      playlistId: string,
      playlistName: string,
      tracks: PlaylistTrackRow[],
    ) => {
      if (!supported) return
      await ensureMediaToken() // so trackStreamUrl carries the media token
      manifestRef.current.playlists[playlistId] = { name: playlistName }
      // Previews aren't real DB tracks — they can't be streamed offline.
      const real = tracks.filter((t) => t.codec !== 'preview')
      setActive((a) => ({ ...a, [playlistId]: { done: 0, total: real.length } }))

      for (let i = 0; i < real.length; i++) {
        const t = real[i]
        try {
          const existing = manifestRef.current.tracks.find(
            (e) =>
              e.video_id === t.video_id &&
              e.codec === t.codec &&
              e.bitrate === t.bitrate,
          )
          if (existing) {
            // Already on disk (another playlist pulled it in) — just ref it.
            if (!existing.playlistIds.includes(playlistId)) {
              existing.playlistIds.push(playlistId)
            }
          } else {
            const streamUrl = api.trackStreamUrl(t.video_id, t.codec, t.bitrate)
            let coverRemote: string | null = null
            try {
              coverRemote = (await api.trackCover(t.video_id)).cover_url
            } catch {
              // fall back to the stored thumbnail inside downloadTrackFiles
            }
            const res = await storage.downloadTrackFiles(t, streamUrl, coverRemote)
            const entry: ManifestEntry = {
              video_id: t.video_id,
              codec: t.codec,
              bitrate: t.bitrate,
              title: t.title,
              artist: t.artist,
              duration_sec: t.duration_sec,
              thumbnail_url: t.thumbnail_url,
              source_url: t.source_url,
              audioFile: res.audioFile,
              coverFile: res.coverFile,
              bytes: res.bytes,
              playlistIds: [playlistId],
            }
            manifestRef.current.tracks.push(entry)
            const audioUrl = await storage.toPlayableUrl(entry.audioFile)
            const coverUrl = entry.coverFile
              ? await storage.toPlayableUrl(entry.coverFile)
              : null
            offlineIndex.set(t.video_id, t.codec, t.bitrate, audioUrl, coverUrl)
          }
        } catch {
          // skip this track, keep going through the rest of the playlist
        }
        setActive((a) => ({
          ...a,
          [playlistId]: { done: i + 1, total: real.length },
        }))
      }

      await storage.writeManifest(manifestRef.current)
      recomputeBytes()
      setActive((a) => {
        const next = { ...a }
        delete next[playlistId]
        return next
      })
    },
    [supported, recomputeBytes],
  )

  const removePlaylist = useCallback(
    async (playlistId: string) => {
      if (!supported) return
      const next: ManifestEntry[] = []
      for (const e of manifestRef.current.tracks) {
        const ids = e.playlistIds.filter((p) => p !== playlistId)
        if (ids.length === 0) {
          await storage.removeFiles(e.audioFile, e.coverFile)
          offlineIndex.remove(e.video_id, e.codec, e.bitrate)
        } else {
          next.push({ ...e, playlistIds: ids })
        }
      }
      manifestRef.current.tracks = next
      delete manifestRef.current.playlists[playlistId]
      await storage.writeManifest(manifestRef.current)
      recomputeBytes()
    },
    [supported, recomputeBytes],
  )

  const offlineTracksFor = useCallback(
    (playlistId: string): PlaylistTrackRow[] =>
      manifestRef.current.tracks
        .filter((e) => e.playlistIds.includes(playlistId))
        .map((e, i) => ({
          video_id: e.video_id,
          codec: e.codec,
          bitrate: e.bitrate,
          title: e.title,
          artist: e.artist,
          duration_sec: e.duration_sec,
          thumbnail_url: e.thumbnail_url,
          source_url: e.source_url,
          file_size: null,
          position: i,
          added_at: '',
        })),
    [],
  )

  const playlistName = useCallback(
    (playlistId: string): string | null =>
      manifestRef.current.playlists[playlistId]?.name ?? null,
    [],
  )

  const value = useMemo<OfflineCtx>(
    () => ({
      supported,
      ready,
      totalBytes,
      isDownloaded,
      progressFor,
      downloadPlaylist,
      removePlaylist,
      offlineTracksFor,
      playlistName,
    }),
    [
      supported,
      ready,
      totalBytes,
      isDownloaded,
      progressFor,
      downloadPlaylist,
      removePlaylist,
      offlineTracksFor,
      playlistName,
    ],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useOffline(): OfflineCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useOffline must be used within OfflineProvider')
  return ctx
}
