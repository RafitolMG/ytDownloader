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

// ── Shared catalog ───────────────────────────────────────────────────────────

export type CatalogSort = 'newest' | 'popular' | 'title' | 'artist'

export type CatalogItem = {
  video_id: string
  codec: string
  bitrate: string
  title: string | null
  artist: string | null
  duration_sec: number | null
  thumbnail_url: string | null
  source_url: string
  file_size: number | null
  downloaded_at: string
  /** Number of users that have this track in their library — used both as the
   * social signal (♥ N) and as the "popular" sort key. */
  owner_count: number
  /** SQLite returns 0/1 for EXISTS subqueries; treat as boolean at the edge. */
  is_owned: 0 | 1
}

export type CatalogResponse = {
  items: CatalogItem[]
}

/** Result from /api/catalog/discover for tracks not yet in the catalog —
 * just enough metadata to render a row + fire a download. */
export type ExternalCatalogItem = {
  video_id: string
  title: string | null
  artist: string | null
  thumbnail_url: string | null
  duration_sec: number | null
  source_url: string
}

export type DiscoverResponse = {
  db: CatalogItem[]
  external: ExternalCatalogItem[]
}

/** At-rest suggestions from /api/catalog/suggestions — YouTube Mix tracks
 * related to the catalog's popular songs that aren't downloaded yet. */
export type SuggestionsResponse = {
  external: ExternalCatalogItem[]
}

// ── Playlists ────────────────────────────────────────────────────────────────

export type PlaylistVisibility = 'public' | 'private'

export type PlaylistSummary = {
  id: string
  owner_id: string
  name: string
  description: string | null
  visibility: PlaylistVisibility
  cover_url: string | null
  created_at: string
  updated_at: string
  track_count: number
  /** 0/1 from SQLite — treat as boolean. */
  is_owner: 0 | 1
}

export type PlaylistTrackRow = {
  video_id: string
  codec: string
  bitrate: string
  title: string | null
  artist: string | null
  duration_sec: number | null
  thumbnail_url: string | null
  source_url: string
  file_size: number | null
  position: number
  added_at: string
}

export type PlaylistDetail = {
  id: string
  owner_id: string
  name: string
  description: string | null
  visibility: PlaylistVisibility
  cover_url: string | null
  created_at: string
  updated_at: string
  is_owner: boolean
  tracks: PlaylistTrackRow[]
}

export type PlaylistsResponse = {
  items: PlaylistSummary[]
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
