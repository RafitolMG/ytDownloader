import { ChromaticTitle } from './ChromaticTitle'
import { NavTabs } from './NavTabs'
import { useAuth } from '@/features/auth/AuthProvider'

export function AppHeader({ queueCount }: { queueCount: number }) {
  const { user, logout } = useAuth()
  return (
    <header className="flex items-center justify-between border-b border-border/60 pb-4 mb-8 gap-4 flex-wrap">
      <div className="flex items-baseline gap-3 vhs-tracking">
        <ChromaticTitle className="text-3xl md:text-4xl">YTDL</ChromaticTitle>
        <span className="font-pixel text-2xl text-cool">· 1989</span>
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <NavTabs queueCount={queueCount} />
        {user && (
          <div className="flex items-center gap-2 font-pixel text-base">
            <span className="text-ink-mid">▸</span>
            <span className="text-cool" style={{ textShadow: '0 0 6px var(--color-cool)' }}>
              {user.username}
            </span>
            {user.role === 'ADMIN' && (
              <span className="text-xs uppercase tracking-widest border border-hot/60 text-hot rounded-xs px-1.5">
                admin
              </span>
            )}
            <button
              type="button"
              onClick={logout}
              className="ml-2 font-pixel text-sm uppercase tracking-widest px-2 py-px border border-ink-lo/50 text-ink-lo hover:text-crit hover:border-crit/60 transition rounded-xs"
              title="logout"
            >
              ⏻ exit
            </button>
          </div>
        )}
      </div>
    </header>
  )
}
