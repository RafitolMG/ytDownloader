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
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/shared/api/client'
import type { LibraryItem } from '@/shared/api/types'
import { useAuth } from '@/features/auth/AuthProvider'

export type RepeatMode = 'off' | 'one' | 'all'

type PlayerCtx = {
  /** Track currently loaded in the <audio> element. Null = nothing playing. */
  current: LibraryItem | null
  /** All tracks in the current queue (original order — not affected by shuffle). */
  queue: LibraryItem[]
  /** Index of `current` within `queue`. -1 when nothing is loaded. */
  index: number
  /** True when `next()` will produce a track to play. In shuffle mode that
   * includes the implicit reshuffle on wrap. Drives the next button's
   * disabled state — `index < queue.length-1` would be wrong in shuffle. */
  canGoNext: boolean
  /** True when `prev()` will land on a previous track (vs. just restarting
   * the current one). */
  canGoPrev: boolean
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
  const queryClient = useQueryClient()
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
  // canGoNext mirrors advanceOrReshuffle's branches: there is a next track
  // when we haven't hit the tail of `order` yet, OR we're in shuffle with
  // >1 track (reshuffle will produce one), OR repeat='all' loops back.
  const canGoNext =
    pos >= 0 &&
    (pos < order.length - 1 || (shuffle && queue.length > 1) || repeat === 'all')
  // canGoPrev: there's an earlier position to walk back to, or repeat='all'
  // wraps to the tail. The >3s rewind-to-start nicety lives in prev() itself
  // and doesn't need to be reflected in this flag.
  const canGoPrev = pos > 0 || (pos >= 0 && repeat === 'all')

  // Has the current track load already been counted as a play? Reset on every
  // track change so each load can be recorded at most once.
  const playRecordedRef = useRef(false)

  // Load the new src whenever the logical current track changes.
  useEffect(() => {
    const el = audioRef.current
    if (!el || !current) return
    playRecordedRef.current = false
    el.src = api.trackStreamUrl(current.video_id, current.codec, current.bitrate)
    el.currentTime = 0
    setPosition(0)
    setDuration(NaN)
    void el.play().catch(() => setIsPlaying(false))
  }, [current && trackKey(current)])

  // Record a play after ~20s of actual listening so skips don't pollute the
  // history that drives "recently played" and personalized daily mixes. The
  // timer (re)arms whenever playback resumes and is cleared on pause / track
  // change; once fired, the guard prevents double-counting this load.
  useEffect(() => {
    if (!current || !isPlaying || playRecordedRef.current) return
    const t = setTimeout(() => {
      playRecordedRef.current = true
      void api
        .recordPlay({
          video_id: current.video_id,
          codec: current.codec,
          bitrate: current.bitrate,
        })
        .then(() => {
          // Refresh the browse surfaces that lean on listening history.
          queryClient.invalidateQueries({ queryKey: ['recent'] })
          queryClient.invalidateQueries({ queryKey: ['daily-mixes'] })
        })
        .catch(() => {
          /* losing a play event is harmless */
        })
    }, 20_000)
    return () => clearTimeout(t)
  }, [current && trackKey(current), isPlaying, queryClient])

  const play = useCallback(
    (nextQueue: LibraryItem[], startAt = 0) => {
      if (nextQueue.length === 0) return
      const clamped = Math.max(0, Math.min(startAt, nextQueue.length - 1))
      const newOrder = buildOrder(nextQueue.length, clamped, shuffle)
      setQueue(nextQueue)
      setOrder(newOrder)
      // When shuffled, buildOrder parks `startAt` at order[0] so pos=0 is the
      // start. When not shuffled, order is identity, so pos must = clamped to
      // actually start at the clicked track instead of always falling back to
      // queue[0].
      setPos(shuffle ? 0 : clamped)
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

  /** End-of-queue advancement shared by `next()` and the audio `ended` event.
   * Behaviour at the tail of the queue:
   *   - shuffle on  + queue.length > 1 → reshuffle (excluding the just-played
   *     track from position 0 so it doesn't repeat back-to-back) and continue.
   *   - shuffle off + repeat 'all'    → loop back to position 0.
   *   - otherwise                     → stay put.
   */
  const advanceOrReshuffle = useCallback(() => {
    if (pos < 0) return
    if (pos + 1 < order.length) {
      setPos(pos + 1)
      return
    }
    if (shuffle && queue.length > 1) {
      const lastQueueIdx = order[pos]
      const candidates = Array.from({ length: queue.length }, (_, i) => i)
        .filter((i) => i !== lastQueueIdx)
      const reshuffled = shuffleArray(candidates)
      // Park the just-played at the end of the new rotation so the cycle stays
      // complete on subsequent wraps.
      setOrder([...reshuffled, lastQueueIdx])
      setPos(0)
      return
    }
    if (repeat === 'all') {
      setPos(0)
    }
  }, [order, pos, queue.length, repeat, shuffle])

  const next = useCallback(() => {
    advanceOrReshuffle()
  }, [advanceOrReshuffle])

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

  // Stop playback the moment there's no session — on logout or when a 401
  // clears the user. Otherwise the <audio> element keeps streaming (and the
  // stream endpoint would start 401ing) after the user has signed out.
  const { user } = useAuth()
  useEffect(() => {
    if (!user) stop()
  }, [user, stop])

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
        // Shuffle ON: buildOrder puts current track at order[0] → pos=0.
        // Shuffle OFF: order is identity → pos must = the queue index of the
        // current track so we don't jump back to queue[0].
        setPos(willBeOn ? 0 : currentQueueIdx)
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
      canGoNext,
      canGoPrev,
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
      current, queue, index, canGoNext, canGoPrev, isPlaying, position, duration,
      shuffle, repeat,
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
          advanceOrReshuffle()
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
