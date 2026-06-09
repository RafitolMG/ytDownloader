import { useState } from 'react'
import { ChromaticTitle } from './ChromaticTitle'
import { NavTabs } from './NavTabs'
import { QueueIndicator } from './QueueIndicator'
import { QueueDrawer } from '@/features/queue/QueueDrawer'
import { useAuth } from '@/features/auth/AuthProvider'

export function AppHeader({ queueCount }: { queueCount: number }) {
  const { user, logout } = useAuth()
  const [queueOpen, setQueueOpen] = useState(false)
  return (
    <header className="flex items-center justify-between border-b border-border/60 pb-3 sm:pb-4 mb-6 sm:mb-8 gap-3 sm:gap-4 flex-wrap">
      <div className="flex items-baseline gap-2 sm:gap-3 vhs-tracking">
        <ChromaticTitle className="text-2xl sm:text-3xl md:text-4xl">YTDL</ChromaticTitle>
        <span className="font-pixel text-lg sm:text-2xl text-cool">· 1989</span>
      </div>

      <div className="flex items-center gap-3 sm:gap-4 flex-wrap">
        <NavTabs />
        <QueueIndicator count={queueCount} onClick={() => setQueueOpen(true)} />
        <QueueDrawer open={queueOpen} onClose={() => setQueueOpen(false)} />
        {user && (
          <div className="flex items-center gap-1 sm:gap-2 font-pixel text-sm sm:text-base">
            <span className="text-ink-mid hidden sm:inline">▸</span>
            <span
              className="text-cool max-w-[8rem] truncate"
              style={{ textShadow: '0 0 6px var(--color-cool)' }}
            >
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
              className="ml-1 sm:ml-2 font-pixel text-sm uppercase tracking-widest px-2 py-px border border-ink-lo/50 text-ink-lo hover:text-crit hover:border-crit/60 transition rounded-xs"
              title="logout"
              aria-label="logout"
            >
              ⏻
              <span className="hidden sm:inline ml-1">exit</span>
            </button>
          </div>
        )}
      </div>
    </header>
  )
}
