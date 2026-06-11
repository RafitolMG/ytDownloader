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
  role: 'ADMIN' | 'USER' | string
}

type AuthState = {
  user: AuthedUser | null
  loading: boolean
  login: (usernameOrEmail: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthedUser | null>(null)
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

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
        if (!(e instanceof ApiError && e.status === 401)) {
          // log but don't blow up — could be network during dev reload
          console.warn('whoami failed:', e)
        }
        setUser(null)
      })
      .finally(() => setLoading(false))
  }, [])

  const login = useCallback(async (usernameOrEmail: string, password: string) => {
    const u = await api.login(usernameOrEmail, password)
    setUser(u as AuthedUser)
    await ensureMediaToken(true)
  }, [])

  const logout = useCallback(async () => {
    try {
      await api.logout()
    } catch {
      // ignore — we drop local state regardless
    }
    clearMediaToken()
    setUser(null)
    navigate('/login', { replace: true })
  }, [navigate])

  // Wire the global 401 handler — when any API call gets a 401, redirect to /login.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null)
      navigate('/login', { replace: true })
    })
    return () => setUnauthorizedHandler(null)
  }, [navigate])

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
