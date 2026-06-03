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

export type ResolutionsResponse =
  | { is_playlist: true }
  | {
      is_playlist?: false
      formats: FormatInfo[]
      thumbnail_url: string | null
      ffmpeg_available: boolean
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
  | { type: 'done'; filename: string }
  | { type: 'error'; message: string }
  | { type: 'cancelled' }
