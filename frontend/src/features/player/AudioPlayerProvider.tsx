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
  /** Position within the play *order* (0-based). Unlike `index` this tracks
   * the play sequence, so it's the right value for an "N of M" counter under
   * shuffle. -1 when nothing is loaded. */
  orderPos: number
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
  /** Output volume, 0..1. */
  volume: number
  setVolume: (v: number) => void
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
  /** ms left until the sleep timer pauses playback; null when no timed sleep is
   * set (also null in end-of-track mode, which has no countdown). */
  sleepRemainingMs: number | null
  /** True when a "stop after the current track" sleep is armed. */
  sleepEndOfTrack: boolean
  /** Arm/replace the sleep timer: a minute count, 'endOfTrack', or null to clear. */
  setSleepTimer: (v: number | 'endOfTrack' | null) => void
  /** Insert a track to play right after the current one. Starts playing it if
   * nothing is loaded. */
  playNext: (track: LibraryItem) => void
  /** Append a track to the end of the play order (starts playback if idle). */
  enqueue: (track: LibraryItem) => void
  /** Drop the entry at the given position in the play order (no-op for the
   * currently playing one). */
  removeFromQueueAt: (orderPos: number) => void
  /** Jump playback to the given position in the play order. */
  jumpTo: (orderPos: number) => void
  /** The queue in play order — what's up next, top to bottom. */
  orderedQueue: { track: LibraryItem; orderPos: number; isCurrent: boolean }[]
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
  const [volume, setVolumeState] = useState(1)
  // Sleep timer: `sleepFireAt` is the epoch-ms deadline for a timed sleep;
  // `sleepEndOfTrack` stops after the current track instead (checked via a ref
  // inside the `ended` handler so it sees the latest value without a re-bind).
  const [sleepFireAt, setSleepFireAt] = useState<number | null>(null)
  const [sleepEndOfTrack, setSleepEndOfTrack] = useState(false)
  const [sleepRemainingMs, setSleepRemainingMs] = useState<number | null>(null)
  const sleepEndOfTrackRef = useRef(false)

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
  // Accumulated wall-clock the current track has actually been *playing* (ms),
  // so the play-recording threshold survives pause/resume instead of restarting
  // its countdown each time. Reset on track change.
  const listenedMsRef = useRef(0)

  // Load the new src whenever the logical current track changes.
  useEffect(() => {
    const el = audioRef.current
    if (!el || !current) return
    let cancelled = false
    playRecordedRef.current = false
    listenedMsRef.current = 0
    // codec 'preview' = a not-yet-downloaded track proxy-streamed from YouTube.
    el.src =
      current.codec === 'preview'
        ? api.previewUrl(current.video_id)
        : api.trackStreamUrl(current.video_id, current.codec, current.bitrate)
    el.currentTime = 0
    setPosition(0)
    setDuration(NaN)
    // Ignore the AbortError from a play() that a rapid track switch interrupts:
    // only flip isPlaying off if this load is still the active one. Otherwise a
    // stale rejection desyncs the UI after the next track has already started.
    void el.play().catch(() => {
      if (!cancelled) setIsPlaying(false)
    })
    return () => {
      cancelled = true
    }
  }, [current && trackKey(current)])

  // Record a play after ~20s of actual listening so skips don't pollute the
  // history that drives "recently played" and personalized daily mixes. The
  // 20s is cumulative across pause/resume: each playing segment adds its
  // wall-clock to `listenedMsRef`, and the timer is armed for only the time
  // still remaining — so pausing at 19s and resuming records almost at once
  // instead of restarting the full countdown. Reset per track above.
  useEffect(() => {
    // Don't log plays for previews — the track isn't in the DB (the FK would
    // fail) and a preview isn't a real listen.
    if (!current || current.codec === 'preview' || !isPlaying || playRecordedRef.current)
      return
    const segmentStart = Date.now()
    const remaining = Math.max(0, 20_000 - listenedMsRef.current)
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
    }, remaining)
    return () => {
      listenedMsRef.current += Date.now() - segmentStart
      clearTimeout(t)
    }
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

  // ── Queue editing ─────────────────────────────────────────────────────────
  // These read the current queue/order/pos via closure (deps below) and update
  // both arrays together, keeping `order` a valid permutation of `queue` indices.

  const enqueue = useCallback(
    (track: LibraryItem) => {
      if (pos < 0) {
        play([track])
        return
      }
      setQueue([...queue, track])
      setOrder([...order, queue.length])
    },
    [queue, order, pos, play],
  )

  const playNext = useCallback(
    (track: LibraryItem) => {
      if (pos < 0) {
        play([track])
        return
      }
      const newIdx = queue.length
      setQueue([...queue, track])
      const o = [...order]
      o.splice(pos + 1, 0, newIdx)
      setOrder(o)
    },
    [queue, order, pos, play],
  )

  const removeFromQueueAt = useCallback(
    (orderPos: number) => {
      // Removing the playing track is left to next()/stop(); ignore it here.
      if (orderPos < 0 || orderPos >= order.length || orderPos === pos) return
      setOrder(order.filter((_, i) => i !== orderPos))
      if (orderPos < pos) setPos(pos - 1)
    },
    [order, pos],
  )

  const jumpTo = useCallback(
    (orderPos: number) => {
      if (orderPos >= 0 && orderPos < order.length) setPos(orderPos)
    },
    [order.length],
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
    // Tear down any armed sleep timer along with playback.
    setSleepFireAt(null)
    setSleepRemainingMs(null)
    setSleepEndOfTrack(false)
    sleepEndOfTrackRef.current = false
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

  const setSleepTimer = useCallback((v: number | 'endOfTrack' | null) => {
    if (v === null) {
      setSleepFireAt(null)
      setSleepRemainingMs(null)
      setSleepEndOfTrack(false)
      sleepEndOfTrackRef.current = false
    } else if (v === 'endOfTrack') {
      setSleepFireAt(null)
      setSleepRemainingMs(null)
      setSleepEndOfTrack(true)
      sleepEndOfTrackRef.current = true
    } else {
      setSleepEndOfTrack(false)
      sleepEndOfTrackRef.current = false
      setSleepFireAt(Date.now() + v * 60_000)
      setSleepRemainingMs(v * 60_000)
    }
  }, [])

  // Tick the timed-sleep countdown once a second; pause (not stop, so the queue
  // survives) when it reaches zero. Background tab throttling can drift the
  // wall clock — fine for a sleep timer; end-of-track mode sidesteps it.
  useEffect(() => {
    if (sleepFireAt === null) return
    const tick = () => {
      const remaining = sleepFireAt - Date.now()
      if (remaining <= 0) {
        audioRef.current?.pause()
        setSleepFireAt(null)
        setSleepRemainingMs(null)
      } else {
        setSleepRemainingMs(remaining)
      }
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [sleepFireAt])

  const setVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v))
    const el = audioRef.current
    if (el) el.volume = clamped
    setVolumeState(clamped)
  }, [])

  // Re-apply volume whenever a new src loads (the element resets to 1 on some
  // browsers) so the user's chosen level sticks across tracks.
  useEffect(() => {
    const el = audioRef.current
    if (el) el.volume = volume
  }, [current && trackKey(current), volume])

  const orderedQueue = useMemo(
    () =>
      order
        .map((qi, orderPos) => ({
          track: queue[qi],
          orderPos,
          isCurrent: orderPos === pos,
        }))
        .filter((x) => x.track != null),
    [order, queue, pos],
  )

  // ── MediaSession: lock-screen / headphone / OS media controls ──────────────
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    if (!current) {
      navigator.mediaSession.metadata = null
      return
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: current.title ?? current.video_id,
      artist: current.artist ?? '',
      artwork: current.thumbnail_url
        ? [{ src: current.thumbnail_url, sizes: '480x360', type: 'image/jpeg' }]
        : [],
    })
  }, [current && trackKey(current)])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused'
  }, [isPlaying])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    ms.setActionHandler('play', () => togglePlay())
    ms.setActionHandler('pause', () => togglePlay())
    ms.setActionHandler('previoustrack', () => prev())
    ms.setActionHandler('nexttrack', () => next())
    return () => {
      ms.setActionHandler('play', null)
      ms.setActionHandler('pause', null)
      ms.setActionHandler('previoustrack', null)
      ms.setActionHandler('nexttrack', null)
    }
  }, [togglePlay, prev, next])

  const value = useMemo<PlayerCtx>(
    () => ({
      current,
      queue,
      index,
      orderPos: pos,
      canGoNext,
      canGoPrev,
      isPlaying,
      position,
      duration,
      shuffle,
      repeat,
      volume,
      setVolume,
      play,
      togglePlay,
      next,
      prev,
      stop,
      seek,
      toggleShuffle,
      cycleRepeat,
      sleepRemainingMs,
      sleepEndOfTrack,
      setSleepTimer,
      playNext,
      enqueue,
      removeFromQueueAt,
      jumpTo,
      orderedQueue,
    }),
    [
      current, queue, index, pos, canGoNext, canGoPrev, isPlaying, position, duration,
      shuffle, repeat, volume, setVolume,
      play, togglePlay, next, prev, stop, seek, toggleShuffle, cycleRepeat,
      sleepRemainingMs, sleepEndOfTrack, setSleepTimer,
      playNext, enqueue, removeFromQueueAt, jumpTo, orderedQueue,
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
          // End-of-track sleep: stop here, leaving the queue intact.
          if (sleepEndOfTrackRef.current) {
            sleepEndOfTrackRef.current = false
            setSleepEndOfTrack(false)
            return
          }
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
