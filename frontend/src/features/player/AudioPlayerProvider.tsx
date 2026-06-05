import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { api } from '@/shared/api/client'
import type { LibraryItem } from '@/shared/api/types'

export type RepeatMode = 'off' | 'one' | 'all'

type PlayerCtx = {
  /** Track currently loaded in the <audio> element. Null = nothing playing. */
  current: LibraryItem | null
  /** All tracks in the current queue (original order — not affected by shuffle). */
  queue: LibraryItem[]
  /** Index of `current` within `queue`. -1 when nothing is loaded. */
  index: number
  isPlaying: boolean
  /** Live playback position in seconds. */
  position: number
  /** Track duration in seconds (from the audio element, may be NaN early). */
  duration: number
  shuffle: boolean
  repeat: RepeatMode
  /**
   * Replace the queue and start playback at `startAt` (queue index, default 0).
   * If shuffle is on, the surrounding tracks are randomized but `startAt`
   * plays first.
   */
  play: (queue: LibraryItem[], startAt?: number) => void
  togglePlay: () => void
  next: () => void
  prev: () => void
  stop: () => void
  seek: (seconds: number) => void
  toggleShuffle: () => void
  cycleRepeat: () => void
}

const Ctx = createContext<PlayerCtx | null>(null)

function trackKey(t: LibraryItem) {
  return `${t.video_id}/${t.codec}/${t.bitrate}`
}

/** Fisher-Yates shuffle. Returns a fresh array; does not mutate input. */
function shuffleArray<T>(arr: T[]): T[] {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Build a play order. When shuffled, `startAt` is forced to position 0
 * and everything else is randomized around it. */
function buildOrder(length: number, startAt: number, shuffle: boolean): number[] {
  const identity = Array.from({ length }, (_, i) => i)
  if (!shuffle) return identity
  const rest = identity.filter((i) => i !== startAt)
  return [startAt, ...shuffleArray(rest)]
}

export function AudioPlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [queue, setQueue] = useState<LibraryItem[]>([])
  /** Permutation of queue indices. `order[pos]` is the queue index playing. */
  const [order, setOrder] = useState<number[]>([])
  /** Position within `order`. -1 when nothing is loaded. */
  const [pos, setPos] = useState(-1)
  const [isPlaying, setIsPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(NaN)
  const [shuffle, setShuffle] = useState(false)
  const [repeat, setRepeat] = useState<RepeatMode>('off')

  const index = pos >= 0 && pos < order.length ? order[pos] : -1
  const current = index >= 0 && index < queue.length ? queue[index] : null

  // Load the new src whenever the logical current track changes.
  useEffect(() => {
    const el = audioRef.current
    if (!el || !current) return
    el.src = api.trackStreamUrl(current.video_id, current.codec, current.bitrate)
    el.currentTime = 0
    setPosition(0)
    setDuration(NaN)
    void el.play().catch(() => setIsPlaying(false))
  }, [current && trackKey(current)])

  const play = useCallback(
    (nextQueue: LibraryItem[], startAt = 0) => {
      if (nextQueue.length === 0) return
      const clamped = Math.max(0, Math.min(startAt, nextQueue.length - 1))
      const newOrder = buildOrder(nextQueue.length, clamped, shuffle)
      setQueue(nextQueue)
      setOrder(newOrder)
      setPos(0)
    },
    [shuffle],
  )

  const togglePlay = useCallback(() => {
    const el = audioRef.current
    if (!el || !current) return
    if (el.paused) {
      void el.play().catch(() => setIsPlaying(false))
    } else {
      el.pause()
    }
  }, [current])

  const next = useCallback(() => {
    setPos((p) => {
      if (p < 0) return p
      if (p + 1 < order.length) return p + 1
      // At end of queue. Wrap in 'all', otherwise stay put.
      return repeat === 'all' ? 0 : p
    })
  }, [order.length, repeat])

  const prev = useCallback(() => {
    const el = audioRef.current
    // If we're more than 3s into the track, restart it instead of stepping back.
    if (el && el.currentTime > 3) {
      el.currentTime = 0
      return
    }
    setPos((p) => {
      if (p < 0) return p
      if (p > 0) return p - 1
      return repeat === 'all' ? order.length - 1 : p
    })
  }, [order.length, repeat])

  const stop = useCallback(() => {
    const el = audioRef.current
    if (el) {
      el.pause()
      el.removeAttribute('src')
      el.load()
    }
    setQueue([])
    setOrder([])
    setPos(-1)
    setIsPlaying(false)
    setPosition(0)
    setDuration(NaN)
  }, [])

  const seek = useCallback((seconds: number) => {
    const el = audioRef.current
    if (!el || Number.isNaN(el.duration)) return
    el.currentTime = Math.max(0, Math.min(seconds, el.duration))
    setPosition(el.currentTime)
  }, [])

  const toggleShuffle = useCallback(() => {
    setShuffle((wasOn) => {
      const willBeOn = !wasOn
      // Rebuild `order` around the currently playing track so the user doesn't
      // get a jarring track change.
      setOrder((prevOrder) => {
        if (prevOrder.length === 0) return prevOrder
        const currentQueueIdx = pos >= 0 ? prevOrder[pos] : 0
        const next = buildOrder(prevOrder.length, currentQueueIdx, willBeOn)
        // After rebuild, the current track is at position 0.
        setPos(0)
        return next
      })
      return willBeOn
    })
  }, [pos])

  const cycleRepeat = useCallback(() => {
    setRepeat((r) => (r === 'off' ? 'all' : r === 'all' ? 'one' : 'off'))
  }, [])

  const value = useMemo<PlayerCtx>(
    () => ({
      current,
      queue,
      index,
      isPlaying,
      position,
      duration,
      shuffle,
      repeat,
      play,
      togglePlay,
      next,
      prev,
      stop,
      seek,
      toggleShuffle,
      cycleRepeat,
    }),
    [
      current, queue, index, isPlaying, position, duration, shuffle, repeat,
      play, togglePlay, next, prev, stop, seek, toggleShuffle, cycleRepeat,
    ],
  )

  return (
    <Ctx.Provider value={value}>
      {children}
      <audio
        ref={audioRef}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onEnded={() => {
          if (repeat === 'one') {
            const el = audioRef.current
            if (el) {
              el.currentTime = 0
              void el.play().catch(() => setIsPlaying(false))
            }
            return
          }
          setPos((p) => {
            if (p < 0) return p
            if (p + 1 < order.length) return p + 1
            return repeat === 'all' ? 0 : p
          })
        }}
        preload="metadata"
        className="hidden"
      />
    </Ctx.Provider>
  )
}

export function useAudioPlayer(): PlayerCtx {
  const ctx = useContext(Ctx)
  if (!ctx) {
    throw new Error('useAudioPlayer must be used inside an AudioPlayerProvider')
  }
  return ctx
}
