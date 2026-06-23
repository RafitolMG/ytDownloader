import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ApiError,
  api,
  clearMediaToken,
  ensureMediaToken,
  setUnauthorizedHandler,
} from '@/shared/api/client'

export type AuthedUser = {
  user_id: string
  username: string
  role: 'ADMIN' | 'USER'
}

type AuthState = {
  user: AuthedUser | null
  loading: boolean
  login: (usernameOrEmail: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

// Persist the last signed-in user so a cold start with no network (airplane
// mode, offline playback) keeps the session instead of bouncing to /login.
const AUTH_USER_KEY = 'ytdl.auth.user'

function readCachedUser(): AuthedUser | null {
  try {
    const raw = localStorage.getItem(AUTH_USER_KEY)
    return raw ? (JSON.parse(raw) as AuthedUser) : null
  } catch {
    return null
  }
}

function writeCachedUser(u: AuthedUser | null): void {
  try {
    if (u) localStorage.setItem(AUTH_USER_KEY, JSON.stringify(u))
    else localStorage.removeItem(AUTH_USER_KEY)
  } catch {
    // storage unavailable — non-fatal
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // Seed from cache so we render signed-in immediately, even offline. whoami
  // below reconciles against the server once (if) the network answers.
  const [user, setUserState] = useState<AuthedUser | null>(readCachedUser)
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  // Keep the persisted copy in lockstep with in-memory user.
  const setUser = useCallback((u: AuthedUser | null) => {
    writeCachedUser(u)
    setUserState(u)
  }, [])

  // Hydrate on mount — backend tells us if the session cookie is valid.
  useEffect(() => {
    api
      .whoami()
      .then((u) => {
        setUser(u as AuthedUser)
        // Native build only: prefetch the media token so <audio>/download can
        // authenticate cross-origin. No-op on the web.
        void ensureMediaToken()
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) {
          // Session genuinely rejected by the server — drop it.
          setUser(null)
        } else {
          // Network unreachable (offline): keep the cached session so downloaded
          // playlists stay playable. Don't log out on a failed fetch.
          console.warn('whoami failed (offline?), keeping cached session:', e)
        }
      })
      .finally(() => setLoading(false))
  }, [setUser])

  // Media tokens are short-lived; refresh while signed in so the synchronous
  // <audio> URL builder always has a live one (ensureMediaToken only re-fetches
  // when near expiry, so this poll is cheap). Native build only.
  useEffect(() => {
    if (!user) return
    const id = setInterval(() => void ensureMediaToken(), 10 * 60_000)
    return () => clearInterval(id)
  }, [user])

  const login = useCallback(
    async (usernameOrEmail: string, password: string) => {
      const u = await api.login(usernameOrEmail, password)
      setUser(u as AuthedUser)
      await ensureMediaToken(true)
    },
    [setUser],
  )

  const logout = useCallback(async () => {
    try {
      await api.logout()
    } catch {
      // ignore — we drop local state regardless
    }
    clearMediaToken()
    setUser(null)
    navigate('/login', { replace: true })
  }, [navigate, setUser])

  // Wire the global 401 handler — when any API call gets a 401, redirect to /login.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null)
      navigate('/login', { replace: true })
    })
    return () => setUnauthorizedHandler(null)
  }, [navigate, setUser])

  const value = useMemo<AuthState>(
    () => ({ user, loading, login, logout }),
    [user, loading, login, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
