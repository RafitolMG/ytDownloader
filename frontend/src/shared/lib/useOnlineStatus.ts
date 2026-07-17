import { useEffect, useState } from 'react'

/**
 * Tracks the browser's online/offline status via the window `online`/`offline`
 * events. Coarse by design: `navigator.onLine` only reports whether the OS has
 * a network route, not whether the backend is reachable — it's a "you're
 * offline" hint (downloaded music still plays), not a connectivity probe.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  )
  useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])
  return online
}
