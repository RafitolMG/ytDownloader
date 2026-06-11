import { useEffect } from 'react'
import { App } from '@capacitor/app'
import { runTopBackHandler } from '@/shared/lib/backStack'

/**
 * Wire the Android hardware back button / edge-back gesture to in-app
 * navigation. Priority: dismiss an open overlay → step back in history → exit
 * at the root. Mount once inside the router. No-op on the web (the listener
 * never fires there).
 */
export function BackButtonHandler() {
  useEffect(() => {
    const handle = App.addListener('backButton', ({ canGoBack }) => {
      if (runTopBackHandler()) return
      if (canGoBack) {
        window.history.back()
      } else {
        void App.exitApp()
      }
    })
    return () => {
      void handle.then((h) => h.remove())
    }
  }, [])
  return null
}
