import { NavLink } from 'react-router-dom'

const baseCls =
  'font-pixel text-lg uppercase tracking-widest px-3 py-1 rounded-xs border transition'

export function NavTabs({ queueCount }: { queueCount: number }) {
  return (
    <nav className="flex items-center gap-2">
      <NavLink
        to="/"
        className={({ isActive }) =>
          `${baseCls} ${
            isActive
              ? 'border-hot text-ink-hi bg-hot/10 shadow-[var(--shadow-glow-hot)]'
              : 'border-border text-ink-mid hover:text-cool hover:border-cool/70'
          }`
        }
      >
        ▶ capture
      </NavLink>
      <NavLink
        to="/queue"
        className={({ isActive }) =>
          `${baseCls} ${
            isActive
              ? 'border-hot text-ink-hi bg-hot/10 shadow-[var(--shadow-glow-hot)]'
              : 'border-border text-ink-mid hover:text-cool hover:border-cool/70'
          }`
        }
      >
        ☰ queue
        {queueCount > 0 && (
          <span className="ml-2 text-cool" style={{ textShadow: '0 0 6px var(--color-cool)' }}>
            ·{queueCount}
          </span>
        )}
      </NavLink>
      <NavLink
        to="/library"
        className={({ isActive }) =>
          `${baseCls} ${
            isActive
              ? 'border-hot text-ink-hi bg-hot/10 shadow-[var(--shadow-glow-hot)]'
              : 'border-border text-ink-mid hover:text-cool hover:border-cool/70'
          }`
        }
      >
        ♪ library
      </NavLink>
    </nav>
  )
}
