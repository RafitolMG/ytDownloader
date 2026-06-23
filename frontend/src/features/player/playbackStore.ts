import { useSyncExternalStore } from 'react'

/**
 * External store for the high-frequency playback time (position + duration).
 *
 * These tick from the <audio> element's `timeupdate` event ~4-60×/s. Holding
 * them in React state on the player context meant the context value changed on
 * every tick, re-rendering EVERY `useAudioPlayer()` consumer — including every
 * visible list row — many times a second. Moving them to a standalone store
 * keeps them out of the context: only the components that actually display the
 * scrubber subscribe (via `usePlaybackTime`), so a tick re-renders just those.
 */
export type PlaybackTime = { position: number; duration: number }

let state: PlaybackTime = { position: 0, duration: NaN }
const listeners = new Set<() => void>()

export function getPlaybackTime(): PlaybackTime {
  return state
}

export function setPlaybackTime(patch: Partial<PlaybackTime>): void {
  const next = { ...state, ...patch }
  // Bail if nothing changed so we don't notify on identical ticks. Object.is
  // handles the NaN === NaN case for duration.
  if (Object.is(next.position, state.position) && Object.is(next.duration, state.duration)) {
    return
  }
  state = next
  listeners.forEach((l) => l())
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Subscribe a component to live position/duration. Returns the latest value;
 *  re-renders the caller only when these change. */
export function usePlaybackTime(): PlaybackTime {
  return useSyncExternalStore(subscribe, getPlaybackTime, getPlaybackTime)
}
