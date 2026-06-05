import type {
  HistoryResponse,
  JobRow,
  LibraryResponse,
  ResolutionsResponse,
  SearchResponse,
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
  }) =>
    json<{ job_id: string }>('/api/download', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  downloadPlaylist: (url: string, quality = 'audio') =>
    json<{ job_id: string }>('/api/download-playlist', {
      method: 'POST',
      body: JSON.stringify({ url, quality }),
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
}
