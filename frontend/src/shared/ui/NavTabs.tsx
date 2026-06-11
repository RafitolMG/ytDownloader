import { NavLink } from 'react-router-dom'
import { useAuth } from '@/features/auth/AuthProvider'

// Labels collapse to icon-only below `md` so the nav fits on phones/small
// tablets without wrapping into a second row. Each tab carries an aria-label
// so the icon-only state is still understandable to screen readers.
//
// The queue isn't here — it's a transient status surface, so it lives behind
// the QueueIndicator in the header rather than as a destination tab.
export type NavTab = { to: string; icon: string; label: string }

const TABS: NavTab[] = [
  { to: '/', icon: '▶', label: 'capture' },
  { to: '/catalog', icon: '⊕', label: 'catalog' },
  { to: '/albums', icon: '◉', label: 'albums' },
  { to: '/playlists', icon: '≣', label: 'playlists' },
  { to: '/import', icon: '⬇', label: 'import' },
  { to: '/stats', icon: '★', label: 'stats' },
]

/** The nav destinations for the current user — adds the admin console only for
 *  ADMINs (RequireAdmin guards the route). Shared by the desktop header tabs and
 *  the mobile bottom bar. */
export function useNavTabs(): NavTab[] {
  const { user } = useAuth()
  return user?.role === 'ADMIN'
    ? [...TABS, { to: '/admin', icon: '◈', label: 'admin' }]
    : TABS
}

const baseCls =
  'focus-vis font-pixel text-base md:text-lg uppercase tracking-widest px-2 md:px-3 py-1 rounded-xs border transition flex items-center gap-2'

export function NavTabs() {
  const tabs = useNavTabs()
  // Hidden on phones — the destinations live in the fixed BottomNav there. The
  // header keeps the title, queue and account controls.
  return (
    <nav className="hidden sm:flex items-center gap-1 md:gap-2 flex-wrap">
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.to === '/'}
          aria-label={t.label}
          title={t.label}
          className={({ isActive }) =>
            `${baseCls} ${
              isActive
                ? 'border-hot text-ink-hi bg-hot/10 shadow-[var(--shadow-glow-hot)]'
                : 'border-border text-ink-mid hover:text-cool hover:border-cool/70'
            }`
          }
        >
          <span>{t.icon}</span>
          <span className="hidden md:inline">{t.label}</span>
        </NavLink>
      ))}
    </nav>
  )
}
