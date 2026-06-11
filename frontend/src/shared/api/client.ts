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

async function json<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
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
  return res.json() as Promise<T>
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

  jobs: () => json<{ jobs: JobRow[] }>('/api/jobs'),

  retry: (jobId: string) =>
    json<{ job_id: string }>(`/api/jobs/${jobId}/retry`, { method: 'POST' }),

  cancel: (jobId: string) =>
    json<{ ok: true }>(`/api/jobs/${jobId}/cancel`, { method: 'POST' }),

  delete: (jobId: string) =>
    json<{ ok: true }>(`/api/jobs/${jobId}`, { method: 'DELETE' }),

  fileUrl: (jobId: string) => `/api/file/${jobId}`,

  // ── auth ──
  login: (usernameOrEmail: string, password: string) =>
    json<{ user_id: string; username: string; role: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ usernameOrEmail, password }),
    }),

  logout: () =>
    fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }),

  whoami: () =>
    json<{ user_id: string; username: string; role: string }>('/api/auth/whoami'),

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
  library: (limit = 500) =>
    json<LibraryResponse>(`/api/library?limit=${limit}`),

  removeFromLibrary: (videoId: string, codec: string, bitrate: string) =>
    json<{ ok: true; orphaned: boolean }>(
      `/api/library/${encodeURIComponent(videoId)}?codec=${encodeURIComponent(codec)}&bitrate=${encodeURIComponent(bitrate)}`,
      { method: 'DELETE' },
    ),

  trackStreamUrl: (videoId: string, codec: string, bitrate: string) =>
    `/api/track/${encodeURIComponent(videoId)}/stream?codec=${encodeURIComponent(codec)}&bitrate=${encodeURIComponent(bitrate)}`,

  /** Proxy-stream URL for previewing a not-yet-downloaded track. */
  previewUrl: (videoId: string) => `/api/preview/${encodeURIComponent(videoId)}`,

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

  suggestions: (params: { limit?: number } = {}) => {
    const qs = new URLSearchParams()
    if (params.limit != null) qs.set('limit', String(params.limit))
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

  radio: (videoId: string, opts: { external_limit?: number } = {}) => {
    const qs = new URLSearchParams()
    if (opts.external_limit != null)
      qs.set('external_limit', String(opts.external_limit))
    const tail = qs.toString()
    return json<RadioFeed>(
      `/api/catalog/radio/${encodeURIComponent(videoId)}${tail ? `?${tail}` : ''}`,
    )
  },

  dailyMixes: (opts: { count?: number; size?: number } = {}) => {
    const qs = new URLSearchParams()
    qs.set('count', String(opts.count ?? 4))
    qs.set('size', String(opts.size ?? 40))
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
