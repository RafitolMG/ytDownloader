import { NavLink } from 'react-router-dom'
import { useAuth } from '@/features/auth/AuthProvider'
import { useNavTabs } from './NavTabs'

/** Fixed bottom navigation for phones (hidden on `sm`+, where the header tabs
 *  take over). Thumb-reachable, full-width tap targets; the mini-player floats
 *  directly above it. The safe-area inset keeps the icons clear of the gesture
 *  bar while the bar's background still fills behind it. */
export function BottomNav() {
  const { user } = useAuth()
  const tabs = useNavTabs()
  // Rendered outside the router, so it would otherwise show over the login
  // screen — hide it until there's a signed-in user to navigate as.
  if (!user) return null
  return (
    <nav
      className="sm:hidden fixed bottom-0 left-0 right-0 z-40 flex items-stretch border-t border-border bg-page-mid/95 backdrop-blur-md pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_32px_rgba(0,0,0,0.6)]"
      aria-label="primary"
    >
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.to === '/'}
          aria-label={t.label}
          className={({ isActive }) =>
            `flex-1 min-w-0 h-14 flex flex-col items-center justify-center gap-0.5 font-pixel transition ${
              isActive
                ? 'text-hot [text-shadow:var(--shadow-glow-hot)]'
                : 'text-ink-mid active:text-cool'
            }`
          }
        >
          <span className="text-xl leading-none">{t.icon}</span>
          <span className="text-[0.6rem] uppercase tracking-wider leading-none">
            {t.label}
          </span>
        </NavLink>
      ))}
    </nav>
  )
}
