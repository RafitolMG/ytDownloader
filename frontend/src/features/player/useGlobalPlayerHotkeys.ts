import { useEffect } from 'react'
import { useAudioPlayer } from './AudioPlayerProvider'

/**
 * Global playback keyboard shortcuts, mounted once (from PlayerBar). Pure
 * leverage over the player actions that already exist. Bindings:
 *   Space            play / pause
 *   ← / →            seek ∓5s
 *   Shift+← / Shift+→  prev / next
 *   ↑ / ↓            volume ±5%
 *   M  mute toggle · S  shuffle · R  cycle repeat
 *
 * No-ops while typing (INPUT/TEXTAREA/SELECT/contenteditable) or when nothing
 * is loaded, so it never hijacks the search box. Only Space is preventDefault'd
 * (it would otherwise scroll the page).
 */
export function useGlobalPlayerHotkeys() {
  const p = useAudioPlayer()
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        el?.isContentEditable
      )
        return
      if (!p.current) return

      switch (e.key) {
        case ' ':
          e.preventDefault()
          p.togglePlay()
          break
        case 'ArrowLeft':
          if (e.shiftKey) p.prev()
          else p.seek(Math.max(0, p.position - 5))
          break
        case 'ArrowRight':
          if (e.shiftKey) p.next()
          else p.seek(p.position + 5)
          break
        case 'ArrowUp':
          e.preventDefault()
          p.setVolume(Math.min(1, p.volume + 0.05))
          break
        case 'ArrowDown':
          e.preventDefault()
          p.setVolume(Math.max(0, p.volume - 0.05))
          break
        case 'm':
        case 'M':
          p.setVolume(p.volume > 0 ? 0 : 1)
          break
        case 's':
        case 'S':
          p.toggleShuffle()
          break
        case 'r':
        case 'R':
          p.cycleRepeat()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [p])
}
