import { useEffect } from 'react'

/**
 * A LIFO stack of "close" handlers for the Android back button / back gesture.
 *
 * Open overlays (now-playing, drawers) push a close handler while visible; the
 * hardware back then dismisses the top-most overlay before it falls through to
 * route navigation (see BackButtonHandler). This mirrors what users expect from
 * the system back gesture on a native app.
 */
type Handler = () => void

const stack: Handler[] = []

/** Pop and run the top-most back handler. Returns true if one handled it. */
export function runTopBackHandler(): boolean {
  const fn = stack[stack.length - 1]
  if (!fn) return false
  fn()
  return true
}

/** Register `onClose` as the back handler while `active` (e.g. an open overlay).
 *  Auto-unregisters on close/unmount. */
export function useBackClose(active: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!active) return
    stack.push(onClose)
    return () => {
      const i = stack.lastIndexOf(onClose)
      if (i !== -1) stack.splice(i, 1)
    }
  }, [active, onClose])
}
