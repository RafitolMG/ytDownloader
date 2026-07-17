import { useState } from 'react'
import { ChromaticTitle } from './ChromaticTitle'
import { NavTabs } from './NavTabs'
import { QueueIndicator } from './QueueIndicator'
import { SideMenu } from './SideMenu'
import { QueueDrawer } from '@/features/queue/QueueDrawer'
import { useOnlineStatus } from '@/shared/lib/useOnlineStatus'

export function AppHeader({ queueCount }: { queueCount: number }) {
  const [queueOpen, setQueueOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const online = useOnlineStatus()
  return (
    <header className="flex items-center justify-between border-b border-border/60 pb-3 sm:pb-4 mb-6 sm:mb-8 gap-3 sm:gap-4 flex-wrap">
      <div className="flex items-center gap-2 sm:gap-3">
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          title="menu"
          aria-label="open menu"
          className="font-pixel text-xl w-9 h-9 flex items-center justify-center border border-border text-ink-mid hover:text-violet hover:border-violet/70 transition rounded-xs"
        >
          ☰
        </button>
        <div className="flex items-baseline gap-2 sm:gap-3 vhs-tracking">
          <ChromaticTitle className="text-2xl sm:text-3xl md:text-4xl">YTDL</ChromaticTitle>
          <span className="font-pixel text-lg sm:text-2xl text-cool">· 1989</span>
        </div>
        {!online && (
          <span
            role="status"
            title="you're offline — downloaded music still plays"
            className="font-pixel text-[10px] uppercase tracking-widest px-2 py-0.5 border border-sun/60 text-sun rounded-xs whitespace-nowrap"
          >
            ◌ offline
          </span>
        )}
      </div>

      <div className="flex items-center gap-3 sm:gap-4 flex-wrap">
        <NavTabs />
        <QueueIndicator count={queueCount} onClick={() => setQueueOpen(true)} />
        <QueueDrawer open={queueOpen} onClose={() => setQueueOpen(false)} />
      </div>

      <SideMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
    </header>
  )
}
