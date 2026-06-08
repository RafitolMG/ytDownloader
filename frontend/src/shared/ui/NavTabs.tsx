import { NavLink } from 'react-router-dom'

// Labels collapse to icon-only below `md` so the nav fits on phones/small
// tablets without wrapping into a second row. Each tab carries an aria-label
// so the icon-only state is still understandable to screen readers.
const TABS: { to: string; icon: string; label: string }[] = [
  { to: '/', icon: '▶', label: 'capture' },
  { to: '/queue', icon: '☰', label: 'queue' },
  { to: '/library', icon: '♪', label: 'library' },
  { to: '/catalog', icon: '⊕', label: 'catalog' },
  { to: '/playlists', icon: '≣', label: 'playlists' },
]

const baseCls =
  'font-pixel text-base md:text-lg uppercase tracking-widest px-2 md:px-3 py-1 rounded-xs border transition flex items-center gap-2'

export function NavTabs({ queueCount }: { queueCount: number }) {
  return (
    <nav className="flex items-center gap-1 md:gap-2 flex-wrap">
      {TABS.map((t) => (
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
          {t.to === '/queue' && queueCount > 0 && (
            <span
              className="text-cool text-sm"
              style={{ textShadow: '0 0 6px var(--color-cool)' }}
            >
              ·{queueCount}
            </span>
          )}
        </NavLink>
      ))}
    </nav>
  )
}
