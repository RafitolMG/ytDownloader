import { ChromaticTitle } from './ChromaticTitle'
import { NavTabs } from './NavTabs'

export function AppHeader({ queueCount }: { queueCount: number }) {
  return (
    <header className="flex items-center justify-between border-b border-border/60 pb-4 mb-8 gap-4 flex-wrap">
      <div className="flex items-baseline gap-3 vhs-tracking">
        <ChromaticTitle className="text-3xl md:text-4xl">YTDL</ChromaticTitle>
        <span className="font-pixel text-2xl text-cool">· 1989</span>
      </div>

      <NavTabs queueCount={queueCount} />
    </header>
  )
}
