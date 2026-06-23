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
  /** Owning user — only populated on the admin jobs view (all owners). */
  owner_id?: string | null
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
  /** All credited artists, joined ", " by the backend (multi-artist display). */
  artist: string | null
  album?: string | null
  album_artist?: string | null
  release_year?: number | null
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
  /** All credited artists, joined ", " by the backend (multi-artist display). */
  artist: string | null
  album?: string | null
  album_artist?: string | null
  release_year?: number | null
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

/** Recently played tracks carry the same shape as catalog items (the player
 * only needs the base fields); extra play stats are ignored at the edge. */
export type RecentResponse = {
  items: CatalogItem[]
}

export type CatalogAccent = 'hot' | 'cool' | 'violet'

/** A curated Browse category card. */
export type Category = {
  slug: string
  title: string
  accent: CatalogAccent
}

export type CategoriesResponse = {
  categories: Category[]
}

/** A category feed: catalog matches you can play + YouTube candidates to grab. */
export type CategoryFeed = {
  category: Category
  db: CatalogItem[]
  external: ExternalCatalogItem[]
}

/** "More like this" radio for a track: what you already have (playable) plus
 * new candidates to download. */
export type RadioFeed = {
  db: CatalogItem[]
  external: ExternalCatalogItem[]
}

/** A rotating daily mix: playable catalog tracks anchored to an artist, plus
 * related tracks not downloaded yet (playing one fetches it to the catalog). */
export type DailyMix = {
  id: string
  title: string
  subtitle: string
  accent: CatalogAccent
  tracks: CatalogItem[]
  external: ExternalCatalogItem[]
}

export type DailyMixesResponse = {
  mixes: DailyMix[]
  /** True when mixes are built from the user's own listening history. */
  personalized: boolean
}

/** A library-addition event for the shared activity feed. Carries enough to
 * render + play the track, plus who added it and when. */
export type ActivityItem = {
  username: string | null
  added_at: string
  video_id: string
  codec: string
  bitrate: string
  title: string | null
  artist: string | null
  album?: string | null
  album_artist?: string | null
  release_year?: number | null
  duration_sec: number | null
  thumbnail_url: string | null
  source_url: string
  file_size: number | null
}

export type ActivityResponse = {
  items: ActivityItem[]
}

export type ArtistStat = { artist: string; play_count: number }

/** Personal listening stats over a window — a lightweight "wrapped". */
export type StatsResponse = {
  window_days: number
  total_plays: number
  top_tracks: CatalogItem[]
  top_artists: ArtistStat[]
}

// ── Albums (YouTube Music) ────────────────────────────────────────────────────

/** An album cover card from `/api/albums/search`. */
export type AlbumCard = {
  album_id: string
  title: string | null
  artist: string | null
  thumbnail: string | null
  track_count: number
  /** Canonical album URL — handed to the playlist-download flow to grab it all. */
  url: string
}

export type AlbumsSearchResponse = {
  albums: AlbumCard[]
}

/** Full album: header + the ordered tracklist. `tracks` is every track in album
 * order (external shape); `db` holds the ones already in the catalog (playable
 * now) — the client matches them by video_id to pick a playable vs download row. */
export type AlbumDetailResponse = {
  album: AlbumCard
  tracks: ExternalCatalogItem[]
  db: CatalogItem[]
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
  is_owner: boolean
}

export type PlaylistTrackRow = {
  video_id: string
  codec: string
  bitrate: string
  title: string | null
  artist: string | null
  album?: string | null
  album_artist?: string | null
  release_year?: number | null
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

// ── Admin ──────────────────────────────────────────────────────────────────

export type AdminOverview = {
  users: number
  tracks: number
  storage_bytes: number
  plays: number
  active_jobs: number
  playlists: number
  schema_version: number
  yt_dlp_version: string
}

export type AdminUser = {
  user_id: string
  username: string
  role: string
  last_seen_at: string
  library_count: number
  play_count: number
}

export type AdminUsersResponse = { users: AdminUser[] }

// Reuses the existing JobRow type (admin sees the same rows across all owners).
export type AdminJobsResponse = { jobs: JobRow[] }

export type AdminTrackSort = 'largest' | 'smallest' | 'newest' | 'oldest' | 'popular'

export type AdminTrack = {
  video_id: string
  codec: string
  bitrate: string
  title: string | null
  artist: string | null
  album: string | null
  duration_sec: number | null
  file_path: string
  file_size: number | null
  downloaded_at: string
  owner_count: number
  /** Number of playlists referencing this track — deleting it cascades these. */
  playlist_count: number
  file_exists: boolean
}

export type AdminTracksResponse = { tracks: AdminTrack[] }

export type AdminDeleteTrackResponse = {
  ok: true
  deleted: true
  bytes_reclaimed: number
  owner_count: number
  playlist_count: number
}

export type AdminSystem = {
  yt_dlp_version: string
  cookies: {
    configured: boolean
    source: 'data' | 'file' | 'repo' | 'none'
    error: string | null
    /** Expiry summary parsed from cookies.txt; null when no cookies file is set. */
    expiry: {
      total: number
      expired_count: number
      min_expiry: number | null
      days_remaining: number | null
    } | null
  }
  extraction: {
    ok: boolean | null
    error: string | null
    checked_at: number
  }
  db: { path: string; size_bytes: number }
  library: {
    path: string
    used_bytes: number
    total_bytes: number
    free_bytes: number
  }
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
