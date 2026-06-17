import { useEffect } from 'react'
import { NavLink } from 'react-router-dom'
import { useAuth } from '@/features/auth/AuthProvider'
import { useBackClose } from '@/shared/lib/backStack'

/** Left slide-over for secondary destinations — import, stats, admin, settings —
 *  kept out of the primary nav so the header / bottom bar stay focused on the
 *  music flow. Also holds the account row + logout. */
export function SideMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, logout } = useAuth()
  useBackClose(open, onClose)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const items = [
    { to: '/import', icon: '⬇', label: 'import' },
    { to: '/stats', icon: '★', label: 'stats' },
    ...(user?.role === 'ADMIN' ? [{ to: '/admin', icon: '◈', label: 'admin' }] : []),
    { to: '/settings', icon: '⚙', label: 'configuración' },
  ]

  return (
    <>
      <div
        onClick={onClose}
        aria-hidden
        className={`fixed inset-0 z-50 bg-page/70 backdrop-blur-sm transition-opacity duration-200 ${
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      />
      <aside
        role="dialog"
        aria-label="menu"
        aria-modal="true"
        className={`fixed top-0 left-0 z-[60] h-full w-72 max-w-[85%] bg-page-mid border-r border-violet/40 shadow-[var(--shadow-glow-violet)] flex flex-col transition-transform duration-200 ease-out pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <header className="flex items-center justify-between px-5 py-4 border-b border-border/60">
          <span className="font-pixel text-xs uppercase tracking-[0.3em] text-violet">
            ░▒▓ menu ▓▒░
          </span>
          <button
            type="button"
            onClick={onClose}
            title="close"
            aria-label="close menu"
            className="font-pixel text-base w-10 h-10 flex items-center justify-center border border-ink-lo/50 text-ink-lo hover:text-crit hover:border-crit/60 active:text-crit transition rounded-xs"
          >
            ✕
          </button>
        </header>

        <nav className="flex-1 overflow-y-auto p-3 flex flex-col gap-1">
          {items.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              onClick={onClose}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 h-12 rounded-xs font-pixel text-base uppercase tracking-widest transition ${
                  isActive
                    ? 'bg-hot/10 text-ink-hi border border-hot/60 shadow-[var(--shadow-glow-hot)]'
                    : 'text-ink-mid border border-transparent hover:text-cool hover:bg-cool/5'
                }`
              }
            >
              <span className="text-xl w-5 text-center">{it.icon}</span>
              {it.label}
            </NavLink>
          ))}
        </nav>

        {user && (
          <div className="border-t border-border/60 p-3 flex items-center justify-between gap-2">
            <div className="min-w-0 font-pixel">
              <div
                className="text-cool truncate"
                style={{ textShadow: '0 0 6px var(--color-cool)' }}
              >
                {user.username}
              </div>
              {user.role === 'ADMIN' && (
                <div className="text-[0.65rem] uppercase tracking-widest text-hot">admin</div>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                onClose()
                void logout()
              }}
              className="font-pixel text-sm uppercase tracking-widest px-3 h-10 flex items-center gap-1 border border-ink-lo/50 text-ink-lo hover:text-crit hover:border-crit/60 transition rounded-xs whitespace-nowrap"
              title="logout"
            >
              ⏻ exit
            </button>
          </div>
        )}
      </aside>
    </>
  )
}
