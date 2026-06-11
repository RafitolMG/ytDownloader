import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { useAudioPlayer } from './AudioPlayerProvider'
import { useGlobalPlayerHotkeys } from './useGlobalPlayerHotkeys'
import { NowPlayingView } from './NowPlayingView'
import { api } from '@/shared/api/client'
import { G } from '@/shared/ui/glyphs'

export function PlayerBar() {
  const p = useAudioPlayer()
  useGlobalPlayerHotkeys()
  const [queueOpen, setQueueOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  if (!p.current) return null

  const t = p.current
  const dur = Number.isFinite(p.duration) ? p.duration : t.duration_sec ?? 0
  const pct = dur > 0 ? Math.min(100, (p.position / dur) * 100) : 0

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-page-mid shadow-[0_-8px_32px_rgba(0,0,0,0.6)] pb-[env(safe-area-inset-bottom)]">
      {queueOpen && <PlayQueuePanel onClose={() => setQueueOpen(false)} />}
      {expanded && <NowPlayingView onClose={() => setExpanded(false)} />}
      {/* Seek bar — clickable strip across the top of the player. A wrapper adds
          a taller hit area and keyboard/ARIA slider semantics. */}
      <div
        role="slider"
        tabIndex={0}
        aria-label="seek"
        aria-valuemin={0}
        aria-valuemax={Math.floor(dur)}
        aria-valuenow={Math.floor(p.position)}
        aria-valuetext={`${fmtTime(p.position)} of ${fmtTime(dur)}`}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') p.seek(Math.max(0, p.position - 5))
          else if (e.key === 'ArrowRight') p.seek(p.position + 5)
        }}
        className="focus-vis relative h-1.5 bg-page cursor-pointer group"
        onClick={(e) => {
          if (dur <= 0) return
          const r = e.currentTarget.getBoundingClientRect()
          const ratio = (e.clientX - r.left) / r.width
          p.seek(ratio * dur)
        }}
      >
        <div
          className="absolute inset-y-0 left-0 bg-gradient-to-r from-violet via-hot to-cool transition-[width]"
          style={{ width: `${pct}%` }}
        />
        <div
          className="absolute inset-y-0 w-2 -ml-1 bg-ink-hi shadow-[var(--shadow-glow-hot)] opacity-0 group-hover:opacity-100 transition"
          style={{ left: `${pct}%` }}
        />
      </div>

      <div className="max-w-6xl mx-auto px-2 sm:px-4 py-2 sm:py-3 flex items-center gap-2 sm:gap-4">
        {/* Cover + title — click to open the expanded "now playing" view. */}
        <div
          role="button"
          tabIndex={0}
          title="open now playing"
          aria-label="open now playing"
          onClick={() => setExpanded(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setExpanded(true)
            }
          }}
          className="focus-vis flex items-center gap-2 sm:gap-3 min-w-0 flex-1 cursor-pointer rounded-xs"
        >
          <div className="relative w-10 sm:w-14 aspect-video flex-shrink-0 rounded-xs overflow-hidden border border-border bg-page">
            {t.thumbnail_url ? (
              <img
                src={t.thumbnail_url}
                alt=""
                className="w-full h-full object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="absolute inset-0 bg-gradient-to-br from-violet/40 via-hot/20 to-cool/30" />
            )}
          </div>
          <div className="min-w-0">
            <div className="font-sans text-sm font-semibold text-ink-hi truncate">
              {t.title ?? t.video_id}
            </div>
            <div className="text-xs text-ink-lo truncate">
              {t.artist ?? '—'}
              {t.album ? <span className="text-ink-lo/70"> · {t.album}</span> : null}
            </div>
          </div>
        </div>

        {/* Transport */}
        <div className="flex items-center gap-1 sm:gap-2">
          <PlayerToggle
            onClick={p.toggleShuffle}
            active={p.shuffle}
            title={p.shuffle ? 'shuffle on' : 'shuffle off'}
            hideOnMobile
          >
            ⇄
          </PlayerToggle>
          <PlayerButton
            onClick={p.prev}
            disabled={!p.canGoPrev && p.position < 3}
            title="prev"
          >
            |◀
          </PlayerButton>
          <PlayerButton onClick={p.togglePlay} primary title={p.isPlaying ? 'pause' : 'play'}>
            {p.isPlaying ? '❚❚' : '▶'}
          </PlayerButton>
          <PlayerButton
            onClick={p.next}
            disabled={!p.canGoNext}
            title="next"
          >
            ▶|
          </PlayerButton>
          <PlayerToggle
            onClick={p.cycleRepeat}
            active={p.repeat !== 'off'}
            title={`repeat: ${p.repeat}`}
            hideOnMobile
          >
            {p.repeat === 'one' ? '↻¹' : '↻'}
          </PlayerToggle>
          <PlayerToggle
            onClick={p.toggleAutoRadio}
            active={p.autoRadio}
            title={p.autoRadio ? 'auto-radio on — keeps playing related tracks' : 'auto-radio off'}
            hideOnMobile
          >
            {G.autoplay}
          </PlayerToggle>
        </div>

        {/* Right cluster: time · volume · queue · close. Kept together with a
            consistent gap and shrink-0 so the controls never collide. */}
        <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
          {/* Time */}
          <div className="hidden sm:block font-pixel text-sm text-ink-lo tabular-nums min-w-[5.5rem] text-right">
            {fmtTime(p.position)} / {fmtTime(dur)}
          </div>

          {/* Volume */}
          <div className="hidden md:flex items-center gap-1.5 w-24 flex-shrink-0">
            <button
              type="button"
              onClick={() => p.setVolume(p.volume > 0 ? 0 : 1)}
              title={p.volume > 0 ? 'mute' : 'unmute'}
              aria-label={p.volume > 0 ? 'mute' : 'unmute'}
              className={`focus-vis font-pixel text-base transition w-5 text-center flex-shrink-0 ${
                p.volume === 0 ? 'text-crit' : 'text-ink-lo hover:text-cool'
              }`}
            >
              {p.volume === 0 ? '♪̸' : '♪'}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={p.volume}
              onChange={(e) => p.setVolume(Number(e.target.value))}
              aria-label="volume"
              className="flex-1 min-w-0 accent-[var(--color-cool)] cursor-pointer"
            />
          </div>

          {p.queue.length > 1 && (
            <span className="hidden lg:inline font-pixel text-xs text-ink-lo uppercase tracking-widest tabular-nums">
              {p.orderPos + 1}/{p.queue.length}
            </span>
          )}
          <SleepButton />
          <button
            type="button"
            onClick={() => setQueueOpen((v) => !v)}
            title="queue"
            aria-label="play queue"
            className={`focus-vis font-pixel text-base w-8 h-8 sm:w-9 sm:h-9 flex items-center justify-center flex-shrink-0 transition rounded-xs border ${
              queueOpen
                ? 'border-cool text-cool bg-cool/10 shadow-[var(--shadow-glow-cool)]'
                : 'border-border text-ink-mid hover:text-cool hover:border-cool/70'
            }`}
          >
            ≣
          </button>
          <button
            type="button"
            onClick={p.stop}
            className="focus-vis font-pixel text-sm uppercase tracking-widest px-2 py-1 flex-shrink-0 border border-ink-lo/50 text-ink-lo hover:text-crit hover:border-crit/60 transition rounded-xs"
            title="close player"
            aria-label="close player"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  )
}

function PlayerButton({
  children,
  onClick,
  disabled,
  primary,
  title,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  primary?: boolean
  title?: string
}) {
  const base =
    'focus-vis font-pixel text-sm sm:text-base flex items-center justify-center transition disabled:opacity-30 disabled:cursor-not-allowed rounded-xs border'
  const variant = primary
    ? 'w-10 h-10 sm:w-11 sm:h-11 border-hot bg-hot/15 text-ink-hi shadow-[var(--shadow-glow-hot)] hover:bg-hot/25'
    : 'w-8 h-8 sm:w-9 sm:h-9 border-border text-ink-mid hover:text-cool hover:border-cool/70'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`${base} ${variant}`}
    >
      {children}
    </button>
  )
}

function PlayerToggle({
  children,
  onClick,
  active,
  title,
  hideOnMobile,
}: {
  children: React.ReactNode
  onClick: () => void
  active: boolean
  title?: string
  hideOnMobile?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`focus-vis w-9 h-9 font-pixel text-base ${hideOnMobile ? 'hidden sm:flex' : 'flex'} items-center justify-center transition rounded-xs border ${
        active
          ? 'border-cool text-cool bg-cool/10 shadow-[var(--shadow-glow-cool)]'
          : 'border-border text-ink-lo hover:text-cool hover:border-cool/70'
      }`}
    >
      {children}
    </button>
  )
}

/** Slide-up panel listing the current play order — jump to any track, drop
 * upcoming ones. Anchored above the player bar. */
function PlayQueuePanel({ onClose }: { onClose: () => void }) {
  const p = useAudioPlayer()
  return (
    <div className="absolute bottom-full right-0 mb-px w-full sm:w-[26rem] sm:right-2 max-h-[60vh] flex flex-col card-vapor rounded-t-sm border border-border shadow-[var(--shadow-glow-cool)]">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
        <span className="font-pixel text-xs text-cool uppercase tracking-[0.2em]">
          ░▒▓ play queue ▓▒░
        </span>
        <div className="flex items-center gap-3">
          <SaveQueueButton />
          <button
            type="button"
            onClick={onClose}
            title="close"
            aria-label="close queue"
            className="font-pixel text-sm text-ink-lo hover:text-crit transition"
          >
            {G.close}
          </button>
        </div>
      </div>
      <ul className="flex-1 overflow-y-auto divide-y divide-border">
        {p.orderedQueue.map(({ track, orderPos, isCurrent }) => (
          <li
            key={`${orderPos}/${track.video_id}`}
            className={`group flex items-center gap-2 px-3 py-2 transition ${
              isCurrent ? 'bg-hot/10' : 'hover:bg-violet/10'
            }`}
          >
            <button
              type="button"
              onClick={() => p.jumpTo(orderPos)}
              className="flex items-center gap-2 min-w-0 flex-1 text-left"
              title="play"
            >
              <span className="font-pixel text-xs w-4 text-center text-ink-lo">
                {isCurrent ? <span className="text-hot">▶</span> : orderPos + 1}
              </span>
              <div className="relative w-10 aspect-video flex-shrink-0 rounded-xs overflow-hidden border border-border bg-page">
                {track.thumbnail_url ? (
                  <img
                    src={track.thumbnail_url}
                    alt=""
                    className="w-full h-full object-cover"
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="absolute inset-0 bg-gradient-to-br from-violet/40 via-hot/20 to-cool/30" />
                )}
              </div>
              <div className="min-w-0">
                <div className="font-sans text-sm text-ink-hi truncate">
                  {track.title ?? track.video_id}
                </div>
                <div className="text-xs text-ink-lo truncate">
                  {track.artist ?? '—'}
                </div>
              </div>
            </button>
            {!isCurrent && (
              <button
                type="button"
                onClick={() => p.removeFromQueueAt(orderPos)}
                title="remove from queue"
                className="font-pixel text-sm w-6 h-6 flex items-center justify-center text-ink-lo opacity-100 lg:opacity-0 lg:group-hover:opacity-100 hover:text-crit transition"
              >
                ✕
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function fmtCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Sleep-timer control: a popover (15/30/60 / end of track / off) with a live
 * countdown on the button while a timed sleep is armed. */
function SleepButton() {
  const p = useAudioPlayer()
  const [open, setOpen] = useState(false)
  const active = p.sleepRemainingMs != null || p.sleepEndOfTrack
  const label =
    p.sleepRemainingMs != null
      ? fmtCountdown(p.sleepRemainingMs)
      : p.sleepEndOfTrack
        ? 'end'
        : null
  const lowTime = p.sleepRemainingMs != null && p.sleepRemainingMs < 60_000

  const opts: { label: string; value: number | 'endOfTrack' | null }[] = [
    { label: '15 min', value: 15 },
    { label: '30 min', value: 30 },
    { label: '60 min', value: 60 },
    { label: 'end of track', value: 'endOfTrack' },
    { label: 'off', value: null },
  ]

  return (
    <div className="relative hidden sm:block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="sleep timer"
        aria-label="sleep timer"
        className={`h-8 sm:h-9 px-2 font-pixel text-base flex items-center justify-center transition rounded-xs border ${
          active
            ? 'border-cool text-cool bg-cool/10 shadow-[var(--shadow-glow-cool)]'
            : 'border-border text-ink-mid hover:text-cool hover:border-cool/70'
        }`}
      >
        {G.sleep}
        {label && (
          <span className={`ml-1 text-[10px] tabular-nums ${lowTime ? 'text-sun' : ''}`}>
            {label}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full right-0 mb-2 z-50 w-36 card-vapor rounded-sm border border-border p-1.5 flex flex-col gap-1 shadow-[var(--shadow-glow-cool)]">
            <div className="font-pixel text-[10px] uppercase tracking-widest text-cool px-1 pb-1">
              ░ sleep ░
            </div>
            {opts.map((o) => (
              <button
                key={o.label}
                type="button"
                onClick={() => {
                  p.setSleepTimer(o.value)
                  setOpen(false)
                }}
                className="text-left font-sans text-sm text-ink-hi px-2 py-1 rounded-xs hover:bg-violet/10 transition"
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** Save the current play order as a new private playlist (preview-only tracks
 * are skipped — they have no DB row). Navigates to the new playlist on success. */
function SaveQueueButton() {
  const p = useAudioPlayer()
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')

  const realTracks = p.orderedQueue.filter((x) => x.track.codec !== 'preview')
  const skipped = p.orderedQueue.length - realTracks.length

  const save = useMutation({
    mutationFn: async () => {
      const fallback = realTracks[0]?.track.title
        ? `Queue — ${realTracks[0].track.title}`
        : 'Saved queue'
      const { id } = await api.createPlaylist({
        name: name.trim() || fallback,
        visibility: 'private',
      })
      for (const { track } of realTracks) {
        try {
          await api.addToPlaylist(id, {
            video_id: track.video_id,
            codec: track.codec,
            bitrate: track.bitrate,
          })
        } catch {
          /* skip a track that can't be added; keep the rest */
        }
      }
      return id
    },
    onSuccess: (id) => {
      setEditing(false)
      navigate(`/playlists/${id}`)
    },
  })

  if (realTracks.length === 0) return null

  if (editing) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!save.isPending) save.mutate()
        }}
        className="flex items-center gap-1"
      >
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="playlist name"
          className="bg-page text-ink-hi text-xs px-2 py-1 border border-border rounded-xs outline-none focus:border-cool w-28 sm:w-36"
        />
        <button
          type="submit"
          disabled={save.isPending}
          title={skipped > 0 ? `${skipped} preview track(s) will be skipped` : undefined}
          className="font-pixel text-xs uppercase tracking-widest px-2 py-1 border border-hot text-hot hover:bg-hot/15 rounded-xs disabled:opacity-40 transition"
        >
          {save.isPending ? '···' : 'save'}
        </button>
      </form>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="save this queue as a playlist"
      className="font-pixel text-xs uppercase tracking-widest text-cool hover:text-ink-hi transition"
    >
      {G.add} save queue
    </button>
  )
}
