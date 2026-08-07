import type {
  AdminOverview,
  AdminUsersResponse,
  AdminJobsResponse,
  AdminTrackSort,
  AdminTracksResponse,
  AdminDeleteTrackResponse,
  AdminSystem,
  JobStatus,
  CatalogResponse,
  CatalogSort,
  DiscoverResponse,
  HistoryResponse,
  JobRow,
  LibraryResponse,
  PlaylistDetail,
  PlaylistVisibility,
  PlaylistsResponse,
  ActivityResponse,
  AlbumsSearchResponse,
  AlbumDetailResponse,
  CategoriesResponse,
  CategoryFeed,
  DailyMixesResponse,
  RadioFeed,
  RecentResponse,
  StatsResponse,
  ResolutionsResponse,
  SearchResponse,
  SuggestionsResponse,
  SuggestResponse,
} from './types'
import type { ZodType } from 'zod'
import { mediaTokenSchema, whoamiSchema } from './schemas'

/**
 * Absolute base URL for the API. Empty on the web build — the SPA is served
 * from the same origin as the backend (or proxied in dev), so relative
 * `/api/...` paths just work. In the native (Capacitor) build it's set via
 * VITE_API_BASE to the public backend URL, because the app is served from its
 * own origin (https://localhost) and must reach the backend cross-origin.
 */
export const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '')

/** True when the SPA and API live on different origins (native build). */
export const IS_REMOTE = API_BASE !== ''

/** Prefix a root-relative path with API_BASE; pass through anything else. */
export function apiUrl(path: string): string {
  return path.startsWith('/') ? API_BASE + path : path
}

/** Build a WebSocket URL. Same-origin on the web (the httponly session cookie
 *  rides along); derived from API_BASE (http→ws, https→wss) in the native build,
 *  where the WebView can't send that cookie cross-origin so we append the same
 *  media-scoped `mt` token used for <audio>/download. */
export function wsUrl(path: string): string {
  if (IS_REMOTE) {
    const authed = mediaToken
      ? `${path}${path.includes('?') ? '&' : '?'}mt=${encodeURIComponent(mediaToken)}`
      : path
    return API_BASE.replace(/^http/, 'ws') + authed
  }
  const loc = window.location
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${loc.host}${path}`
}

// ── media token (native only) ────────────────────────────────────────────────
// <audio>/download requests are issued by the element, not by JS, so in the
// native build they can't carry the httponly session cookie cross-origin. We
// fetch a short-lived, signed, media-scoped token (over a normal cookie-authed
// request) and append it as `mt`. It expires, so we re-fetch ahead of expiry
// (AuthProvider also polls this while signed in). No-op on the web.
let mediaToken: string | null = null
let mediaTokenExpiresAt = 0 // epoch ms; 0 = none
// Refresh this far before expiry so a long listen never streams with a dead
// token (the synchronous URL builder reads whatever is cached at play time).
const MEDIA_TOKEN_REFRESH_MARGIN_MS = 30 * 60_000

/** Per-session cache of square album-cover URLs (null = looked up, none found). */
const coverCache = new Map<string, string | null>()

/** Fetch + cache the media token, refreshing when near expiry. Returns null
 *  (and does nothing) on the web, where the cookie rides along same-origin. */
export async function ensureMediaToken(force = false): Promise<string | null> {
  if (!IS_REMOTE) return null
  const fresh = mediaToken && Date.now() < mediaTokenExpiresAt - MEDIA_TOKEN_REFRESH_MARGIN_MS
  if (fresh && !force) return mediaToken
  try {
    const r = await json('/api/auth/media-token', undefined, mediaTokenSchema)
    mediaToken = r.token
    mediaTokenExpiresAt = Date.now() + (r.expires_in ?? 3600) * 1000
  } catch {
    mediaToken = null
    mediaTokenExpiresAt = 0
  }
  return mediaToken
}

/** Drop the cached media token (call on logout). */
export function clearMediaToken(): void {
  mediaToken = null
  mediaTokenExpiresAt = 0
}

/** Append the media token to a media URL in the native build. */
function mediaUrl(path: string): string {
  if (!IS_REMOTE || !mediaToken) return apiUrl(path)
  const sep = path.includes('?') ? '&' : '?'
  return apiUrl(`${path}${sep}mt=${encodeURIComponent(mediaToken)}`)
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

let onUnauthorized: (() => void) | null = null

/** Register a global handler invoked whenever the backend returns 401. */
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn
}

async function json<T>(
  input: RequestInfo,
  init?: RequestInit,
  schema?: ZodType<T>,
): Promise<T> {
  const res = await fetch(typeof input === 'string' ? apiUrl(input) : input, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (res.status === 401 && onUnauthorized) {
    onUnauthorized()
  }
  if (!res.ok) {
    const body = await res.text()
    let detail = body
    try {
      detail = JSON.parse(body).detail ?? body
    } catch {
      // body is not JSON
    }
    throw new ApiError(res.status, `${res.status}: ${detail}`)
  }
  const data = await res.json()
  // Validate at the boundary when a schema is supplied — a contract drift then
  // surfaces as a clear error here instead of a bad type deep in a component.
  if (schema) {
    const parsed = schema.safeParse(data)
    if (!parsed.success) {
      const where = typeof input === 'string' ? input : 'response'
      throw new ApiError(res.status, `unexpected response shape from ${where}`)
    }
    return parsed.data
  }
  return data as T
}

export const api = {
  resolutions: (url: string) =>
    json<ResolutionsResponse>('/api/resolutions', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),

  download: (payload: {
    url: string
    format_code: string
    resolution?: string | null
    ext?: string | null
    as_file?: boolean
    /** false → register in the shared catalog without owning (favouriting) it. */
    own?: boolean
  }) =>
    json<{ job_id: string }>('/api/download', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  downloadPlaylist: (
    url: string,
    opts: { quality?: string; as_file?: boolean } = {},
  ) =>
    json<{ job_id: string }>('/api/download-playlist', {
      method: 'POST',
      body: JSON.stringify({
        url,
        quality: opts.quality ?? 'mp3-320',
        as_file: opts.as_file ?? false,
      }),
    }),

  /** Bulk-import a Spotify playlist link or a pasted "Artist - Title" / CSV
   *  list. Each track is re-found on YT Music and downloaded. Returns a job id
   *  to follow over the same /ws/progress channel as a playlist download. */
  importTracklist: (source: string) =>
    json<{ job_id: string }>('/api/import/tracklist', {
      method: 'POST',
      body: JSON.stringify({ source }),
    }),

  jobs: () => json<{ jobs: JobRow[] }>('/api/jobs'),

  retry: (jobId: string) =>
    json<{ job_id: string }>(`/api/jobs/${jobId}/retry`, { method: 'POST' }),

  cancel: (jobId: string) =>
    json<{ ok: true }>(`/api/jobs/${jobId}/cancel`, { method: 'POST' }),

  delete: (jobId: string) =>
    json<{ ok: true }>(`/api/jobs/${jobId}`, { method: 'DELETE' }),

  fileUrl: (jobId: string) => mediaUrl(`/api/file/${jobId}`),

  // ── auth ──
  login: (usernameOrEmail: string, password: string) =>
    json(
      '/api/auth/login',
      { method: 'POST', body: JSON.stringify({ usernameOrEmail, password }) },
      whoamiSchema,
    ),

  logout: () =>
    fetch(apiUrl('/api/auth/logout'), { method: 'POST', credentials: 'include' }),

  whoami: () => json('/api/auth/whoami', undefined, whoamiSchema),

  authConfig: () =>
    json<{ homeauth_base_url: string; register_url: string }>('/api/auth/config'),

  // ── search ──
  suggest: (q: string, hl = 'es') =>
    json<SuggestResponse>(
      `/api/search/suggest?q=${encodeURIComponent(q)}&hl=${encodeURIComponent(hl)}`,
    ),

  search: (q: string, limit = 20) =>
    json<SearchResponse>(
      `/api/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),

  history: (limit = 20) => json<HistoryResponse>(`/api/history?limit=${limit}`),

  // ── albums (youtube music) ──
  albumSearch: (q: string, limit = 12) =>
    json<AlbumsSearchResponse>(
      `/api/albums/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),

  album: (albumId: string) =>
    json<AlbumDetailResponse>(`/api/albums/${encodeURIComponent(albumId)}`),

  /** Re-find a library album (title-grouped owned tracks, no album id) on
   *  YouTube Music so the client can show the tracks the user is missing. */
  albumResolve: (title: string, artist?: string | null) =>
    json<AlbumDetailResponse>(
      `/api/albums/resolve?title=${encodeURIComponent(title)}` +
        (artist ? `&artist=${encodeURIComponent(artist)}` : ''),
    ),

  // ── admin: metadata backfill (offline, from embedded file tags) ──
  adminBackfillMetadata: (
    opts: { onlyMissing?: boolean; overwriteArtist?: boolean } = {},
  ) => {
    const qs = new URLSearchParams()
    qs.set('only_missing', String(opts.onlyMissing ?? true))
    qs.set('overwrite_artist', String(opts.overwriteArtist ?? true))
    return json<{
      scanned: number
      updated: number
      no_file: number
      no_new_tags: number
    }>(`/api/admin/tracks/backfill-metadata?${qs.toString()}`, { method: 'POST' })
  },

  // ── admin: re-normalize over-stuffed artist strings (offline, in-DB) ──
  adminNormalizeArtists: () =>
    json<{
      scanned: number
      updated: number
      samples: { before: string; after: string }[]
    }>(`/api/admin/tracks/normalize-artists`, { method: 'POST' }),

  // ── admin: re-fetch clean performer lists from YouTube Music (online) ──
  adminRefetchArtists: () =>
    json<{
      scanned: number
      updated: number
      no_clean: number
      samples: { before: string; after: string }[]
    }>(`/api/admin/tracks/refetch-artists`, { method: 'POST' }),

  // ── music library ──
  // Default high so the whole library loads — the Liked/Playlists/Albums views
  // sort, search and "play all" over the full set client-side. Backend caps at
  // the same ceiling; 500 used to silently truncate larger libraries.
  library: (limit = 10000) =>
    json<LibraryResponse>(`/api/library?limit=${limit}`),

  removeFromLibrary: (videoId: string, codec: string, bitrate: string) =>
    json<{ ok: true; orphaned: boolean }>(
      `/api/library/${encodeURIComponent(videoId)}?codec=${encodeURIComponent(codec)}&bitrate=${encodeURIComponent(bitrate)}`,
      { method: 'DELETE' },
    ),

  trackStreamUrl: (videoId: string, codec: string, bitrate: string) =>
    mediaUrl(
      `/api/track/${encodeURIComponent(videoId)}/stream?codec=${encodeURIComponent(codec)}&bitrate=${encodeURIComponent(bitrate)}`,
    ),

  /** Proxy-stream URL for previewing a not-yet-downloaded track. */
  previewUrl: (videoId: string) => mediaUrl(`/api/preview/${encodeURIComponent(videoId)}`),

  /** Square album cover (YT Music) for the now-playing screen + notification —
   *  the stored thumbnail is a 16:9 video frame. Cached per session. */
  trackCover: async (videoId: string): Promise<{ cover_url: string | null }> => {
    const hit = coverCache.get(videoId)
    if (hit !== undefined) return { cover_url: hit }
    const r = await json<{ cover_url: string | null }>(
      `/api/track/${encodeURIComponent(videoId)}/cover`,
    )
    coverCache.set(videoId, r.cover_url)
    return r
  },

  // ── shared catalog ──
  catalog: (params: {
    q?: string
    sort?: CatalogSort
    owned_only?: boolean
    limit?: number
    offset?: number
  } = {}) => {
    const qs = new URLSearchParams()
    if (params.q) qs.set('q', params.q)
    if (params.sort) qs.set('sort', params.sort)
    if (params.owned_only) qs.set('owned_only', 'true')
    if (params.limit != null) qs.set('limit', String(params.limit))
    if (params.offset != null) qs.set('offset', String(params.offset))
    const tail = qs.toString()
    return json<CatalogResponse>(`/api/catalog/tracks${tail ? `?${tail}` : ''}`)
  },

  discover: (params: { q: string; limit?: number; external_limit?: number }) => {
    const qs = new URLSearchParams()
    qs.set('q', params.q)
    if (params.limit != null) qs.set('limit', String(params.limit))
    if (params.external_limit != null) qs.set('external_limit', String(params.external_limit))
    return json<DiscoverResponse>(`/api/catalog/discover?${qs.toString()}`)
  },

  suggestions: (params: { limit?: number; refresh?: number } = {}) => {
    const qs = new URLSearchParams()
    if (params.limit != null) qs.set('limit', String(params.limit))
    if (params.refresh) qs.set('refresh', String(params.refresh))
    const tail = qs.toString()
    return json<SuggestionsResponse>(
      `/api/catalog/suggestions${tail ? `?${tail}` : ''}`,
    )
  },

  // ── browse: play history, categories, daily mixes ──
  recordPlay: (key: { video_id: string; codec: string; bitrate: string }) =>
    json<{ ok: true }>('/api/track/play', {
      method: 'POST',
      body: JSON.stringify(key),
    }),

  recentPlays: (limit = 20) =>
    json<RecentResponse>(`/api/me/recent?limit=${limit}`),

  myStats: (windowDays = 30) =>
    json<StatsResponse>(`/api/me/stats?window_days=${windowDays}`),

  activity: (limit = 30) =>
    json<ActivityResponse>(`/api/activity?limit=${limit}`),

  categories: () => json<CategoriesResponse>('/api/catalog/categories'),

  category: (
    slug: string,
    opts: { limit?: number; external_limit?: number } = {},
  ) => {
    const qs = new URLSearchParams()
    if (opts.limit != null) qs.set('limit', String(opts.limit))
    if (opts.external_limit != null)
      qs.set('external_limit', String(opts.external_limit))
    const tail = qs.toString()
    return json<CategoryFeed>(
      `/api/catalog/category/${encodeURIComponent(slug)}${tail ? `?${tail}` : ''}`,
    )
  },

  radio: (
    videoId: string,
    opts: { external_limit?: number; refresh?: number } = {},
  ) => {
    const qs = new URLSearchParams()
    if (opts.external_limit != null)
      qs.set('external_limit', String(opts.external_limit))
    if (opts.refresh) qs.set('refresh', String(opts.refresh))
    const tail = qs.toString()
    return json<RadioFeed>(
      `/api/catalog/radio/${encodeURIComponent(videoId)}${tail ? `?${tail}` : ''}`,
    )
  },

  dailyMixes: (opts: { count?: number; size?: number; refresh?: number } = {}) => {
    const qs = new URLSearchParams()
    // 6 distinct-kind mixes (artist / era / on-repeat / deep-cuts / discovery)
    // now that the backend diversifies them; was 4 near-identical artist mixes.
    qs.set('count', String(opts.count ?? 6))
    qs.set('size', String(opts.size ?? 40))
    if (opts.refresh) qs.set('refresh', String(opts.refresh))
    return json<DailyMixesResponse>(`/api/catalog/daily-mixes?${qs.toString()}`)
  },

  catalogAdopt: (videoId: string, codec: string, bitrate: string) =>
    json<{ ok: true; owned: true }>(
      `/api/catalog/tracks/${encodeURIComponent(videoId)}/${encodeURIComponent(codec)}/${encodeURIComponent(bitrate)}/own`,
      { method: 'POST' },
    ),

  catalogUnown: (videoId: string, codec: string, bitrate: string) =>
    json<{ ok: true; owned: false; orphaned?: boolean }>(
      `/api/catalog/tracks/${encodeURIComponent(videoId)}/${encodeURIComponent(codec)}/${encodeURIComponent(bitrate)}/own`,
      { method: 'DELETE' },
    ),

  // ── playlists ──
  playlists: (opts: { owner?: 'me' | string; limit?: number } = {}) => {
    const qs = new URLSearchParams()
    if (opts.owner) qs.set('owner_id', opts.owner)
    if (opts.limit != null) qs.set('limit', String(opts.limit))
    const tail = qs.toString()
    return json<PlaylistsResponse>(`/api/playlists${tail ? `?${tail}` : ''}`)
  },

  createPlaylist: (payload: {
    name: string
    description?: string | null
    visibility?: PlaylistVisibility
  }) =>
    json<{ id: string }>(`/api/playlists`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  playlist: (id: string) =>
    json<PlaylistDetail>(`/api/playlists/${encodeURIComponent(id)}`),

  updatePlaylist: (
    id: string,
    patch: {
      name?: string
      description?: string | null
      visibility?: PlaylistVisibility
      cover_url?: string | null
    },
  ) =>
    json<{ ok: true }>(`/api/playlists/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deletePlaylist: (id: string) =>
    json<{ ok: true }>(`/api/playlists/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  addToPlaylist: (
    id: string,
    key: { video_id: string; codec: string; bitrate: string },
  ) =>
    json<{ ok: true; added: boolean }>(
      `/api/playlists/${encodeURIComponent(id)}/tracks`,
      { method: 'POST', body: JSON.stringify(key) },
    ),

  /** Append many tracks in one request (vs. N sequential addToPlaylist calls). */
  addTracksToPlaylist: (
    id: string,
    tracks: { video_id: string; codec: string; bitrate: string }[],
  ) =>
    json<{ ok: true; added: number }>(
      `/api/playlists/${encodeURIComponent(id)}/tracks/bulk`,
      { method: 'POST', body: JSON.stringify({ tracks }) },
    ),

  removeFromPlaylist: (
    id: string,
    videoId: string,
    codec: string,
    bitrate: string,
  ) =>
    json<{ ok: true }>(
      `/api/playlists/${encodeURIComponent(id)}/tracks/${encodeURIComponent(videoId)}/${encodeURIComponent(codec)}/${encodeURIComponent(bitrate)}`,
      { method: 'DELETE' },
    ),

  reorderPlaylist: (
    id: string,
    order: Array<{ video_id: string; codec: string; bitrate: string }>,
  ) =>
    json<{ ok: true; reordered: number }>(
      `/api/playlists/${encodeURIComponent(id)}/order`,
      { method: 'PATCH', body: JSON.stringify({ order }) },
    ),

  // ── admin ──
  adminOverview: () => json<AdminOverview>('/api/admin/overview'),

  adminUsers: () => json<AdminUsersResponse>('/api/admin/users'),

  adminJobs: (params: { status?: JobStatus; limit?: number } = {}) => {
    const qs = new URLSearchParams()
    if (params.status) qs.set('status', params.status)
    if (params.limit != null) qs.set('limit', String(params.limit))
    const tail = qs.toString()
    return json<AdminJobsResponse>(`/api/admin/jobs${tail ? `?${tail}` : ''}`)
  },

  adminTracks: (
    params: {
      sort?: AdminTrackSort
      limit?: number
      offset?: number
    } = {},
  ) => {
    const qs = new URLSearchParams()
    if (params.sort) qs.set('sort', params.sort)
    if (params.limit != null) qs.set('limit', String(params.limit))
    if (params.offset != null) qs.set('offset', String(params.offset))
    const tail = qs.toString()
    return json<AdminTracksResponse>(`/api/admin/tracks${tail ? `?${tail}` : ''}`)
  },

  adminDeleteTrack: (
    videoId: string,
    codec: string,
    bitrate: string,
    opts: { force?: boolean } = {},
  ) => {
    const qs = new URLSearchParams()
    if (opts.force) qs.set('force', 'true')
    const tail = qs.toString()
    return json<AdminDeleteTrackResponse>(
      `/api/admin/tracks/${encodeURIComponent(videoId)}/${encodeURIComponent(codec)}/${encodeURIComponent(bitrate)}${tail ? `?${tail}` : ''}`,
      { method: 'DELETE' },
    )
  },

  adminSystem: () => json<AdminSystem>('/api/admin/system'),
}
