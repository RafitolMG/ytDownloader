export type JobStatus =
  | 'queued'
  | 'downloading'
  | 'merging'
  | 'transcoding'
  | 'done'
  | 'error'
  | 'interrupted'
  | 'cancelled'

export const ACTIVE_STATUSES: ReadonlyArray<JobStatus> = [
  'queued',
  'downloading',
  'merging',
  'transcoding',
]

export type JobRow = {
  id: string
  url: string
  title: string | null
  uploader: string | null
  thumbnail_url: string | null
  duration_sec: number | null
  format_code: string
  resolution: string | null
  ext: string | null
  size_bytes: number | null
  status: JobStatus
  progress_pct: number
  error_message: string | null
  is_playlist: 0 | 1
  playlist_title: string | null
  playlist_count: number | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export type FormatInfo = {
  format_code: string
  resolution: string
  ext: string
  needs_merge: boolean
  size_display: string
}

export type PlaylistTrack = {
  id: string
  title: string
  url: string
  duration_sec: number | null
  thumbnail: string | null
}

export type ResolutionsResponse =
  | {
      is_playlist: true
      title: string
      count: number
      thumbnail_url: string | null
      tracks: PlaylistTrack[]
    }
  | {
      is_playlist?: false
      formats: FormatInfo[]
      thumbnail_url: string | null
      ffmpeg_available: boolean
      /** True when the video looks like a song — categories includes "Music",
       * uploader is a "- Topic" channel, or YouTube Music metadata is set.
       * Drives whether the "add to library" audio option is shown. */
      is_music: boolean
    }

// ── Search ────────────────────────────────────────────────────────────────────

export type SuggestResponse = {
  suggestions: string[]
}

export type SearchResultItem = {
  id: string
  title: string
  channel: string | null
  channel_url: string | null
  thumbnail: string | null
  duration_seconds: number | null
  view_count: number | null
  url: string
}

export type SearchResponse = {
  results: SearchResultItem[]
}

export type HistoryItem = {
  id: string
  title: string | null
  channel: string | null
  thumbnail: string | null
  duration_seconds: number | null
  url: string
  completed_at: string | null
}

export type HistoryResponse = {
  items: HistoryItem[]
}

// ── Music library ────────────────────────────────────────────────────────────

export type LibraryItem = {
  video_id: string
  codec: string
  bitrate: string
  title: string | null
  artist: string | null
  duration_sec: number | null
  thumbnail_url: string | null
  source_url: string
  file_size: number | null
  added_at: string
  source_playlist_title: string | null
}

export type LibraryResponse = {
  items: LibraryItem[]
}

export type WsEvent =
  | { type: 'snapshot'; job: JobRow }
  | {
      type: 'metadata'
      title?: string | null
      uploader?: string | null
      thumbnail_url?: string | null
      duration_sec?: number | null
      playlist_title?: string | null
      playlist_count?: number | null
    }
  | { type: 'progress'; value: number }
  | { type: 'status'; value: JobStatus }
  | { type: 'track'; index: number; total: number; title: string }
  | {
      type: 'track_skipped'
      index: number
      total: number
      title: string
      message: string
    }
  | {
      type: 'done'
      filename: string | null
      imported?: number
      reused?: number
      skipped?: number
    }
  | { type: 'error'; message: string }
  | { type: 'cancelled' }
