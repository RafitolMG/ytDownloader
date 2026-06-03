import { useEffect, useState } from 'react'
import { Navigate, useLocation, useNavigate, type Location } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/features/auth/AuthProvider'
import { ChromaticTitle } from '@/shared/ui/ChromaticTitle'
import { ApiError, api } from '@/shared/api/client'

type LocationState = { from?: string }

export default function LoginPage() {
  const { user, login, loading } = useAuth()
  const navigate = useNavigate()
  const location = useLocation() as Location & { state: LocationState | null }
  const redirectTo = location.state?.from ?? '/'

  // Already authenticated? Skip the form.
  useEffect(() => {
    /* no-op — render handles this via early return below */
  }, [user, loading])
  if (!loading && user) return <Navigate to={redirectTo} replace />

  const [usernameOrEmail, setUsernameOrEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const authConfig = useQuery({
    queryKey: ['auth-config'],
    queryFn: api.authConfig,
    staleTime: Infinity,
  })

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!usernameOrEmail.trim() || !password) return
    setBusy(true)
    setErr(null)
    try {
      await login(usernameOrEmail.trim(), password)
      navigate(redirectTo, { replace: true })
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 401) setErr('invalid credentials')
        else if (e.status === 503) setErr('auth service unreachable')
        else setErr(e.message)
      } else {
        setErr(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative z-10 min-h-screen flex items-center justify-center px-6 py-8">
      <form
        onSubmit={onSubmit}
        className="card-vapor rounded-sm p-8 w-full max-w-md"
      >
        <div className="flex items-baseline gap-3 mb-6 vhs-tracking">
          <ChromaticTitle className="text-3xl">YTDL</ChromaticTitle>
          <span className="font-pixel text-2xl text-cool">· 1989</span>
        </div>

        <div className="font-pixel text-xs text-ink-lo uppercase tracking-[0.2em] mb-4">
          ░▒▓ access gate ▓▒░
        </div>

        <label className="block mb-4">
          <span className="font-pixel text-sm text-ink-mid uppercase tracking-widest block mb-1">
            ▸ identity
          </span>
          <input
            type="text"
            value={usernameOrEmail}
            onChange={(e) => setUsernameOrEmail(e.target.value)}
            placeholder="username or email"
            autoComplete="username"
            autoFocus
            spellCheck={false}
            className="w-full bg-page/60 border border-border rounded-xs px-3 py-2 font-pixel text-xl text-ink-hi placeholder:text-ink-lo outline-none focus:border-cool focus:shadow-[var(--shadow-glow-cool)] transition"
          />
        </label>

        <label className="block mb-6">
          <span className="font-pixel text-sm text-ink-mid uppercase tracking-widest block mb-1">
            ▸ key
          </span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            autoComplete="current-password"
            className="w-full bg-page/60 border border-border rounded-xs px-3 py-2 font-pixel text-xl text-ink-hi placeholder:text-ink-lo outline-none focus:border-cool focus:shadow-[var(--shadow-glow-cool)] transition"
          />
        </label>

        {err && (
          <div className="font-pixel text-crit mb-4 border border-crit/60 rounded-xs px-3 py-2 bg-crit/10">
            ⚠ {err}
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !usernameOrEmail.trim() || !password}
          className="w-full font-pixel text-xl uppercase tracking-widest px-5 py-2 border border-hot bg-hot/15 text-ink-hi shadow-[var(--shadow-glow-hot)] hover:bg-hot/25 disabled:opacity-40 disabled:cursor-not-allowed transition rounded-xs"
        >
          {busy ? '··· authenticating' : '▶ jack in'}
        </button>

        {authConfig.data?.register_url && (
          <div className="mt-4 flex items-center gap-3 text-ink-lo">
            <span className="flex-1 h-px bg-border/60" />
            <span className="font-pixel text-xs uppercase tracking-widest">no account?</span>
            <span className="flex-1 h-px bg-border/60" />
          </div>
        )}

        {authConfig.data?.register_url && (
          <a
            href={authConfig.data.register_url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 block w-full text-center font-pixel text-lg uppercase tracking-widest px-5 py-2 border border-cool/60 text-cool hover:bg-cool/10 hover:shadow-[var(--shadow-glow-cool)] transition rounded-xs"
          >
            ✦ new identity ↗
          </a>
        )}

        <div className="mt-6 text-center font-pixel text-xs text-ink-lo">
          ＡＵＴＨ ＶＩＡ homeauth
        </div>
      </form>
    </div>
  )
}
