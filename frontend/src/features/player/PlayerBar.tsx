import { useState } from 'react'
import { useAudioPlayer } from './AudioPlayerProvider'

export function PlayerBar() {
  const p = useAudioPlayer()
  const [queueOpen, setQueueOpen] = useState(false)
  if (!p.current) return null

  const t = p.current
  const dur = Number.isFinite(p.duration) ? p.duration : t.duration_sec ?? 0
  const pct = dur > 0 ? Math.min(100, (p.position / dur) * 100) : 0

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-page-mid shadow-[0_-8px_32px_rgba(0,0,0,0.6)]">
      {queueOpen && <PlayQueuePanel onClose={() => setQueueOpen(false)} />}
      {/* Seek bar — clickable strip across the top of the player */}
      <div
        className="relative h-1.5 bg-page cursor-pointer group"
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
        {/* Cover + title */}
        <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
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
              className={`font-pixel text-base transition w-5 text-center flex-shrink-0 ${
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
          <button
            type="button"
            onClick={() => setQueueOpen((v) => !v)}
            title="queue"
            aria-label="play queue"
            className={`font-pixel text-base w-8 h-8 sm:w-9 sm:h-9 flex items-center justify-center flex-shrink-0 transition rounded-xs border ${
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
            className="font-pixel text-sm uppercase tracking-widest px-2 py-1 flex-shrink-0 border border-ink-lo/50 text-ink-lo hover:text-crit hover:border-crit/60 transition rounded-xs"
            title="close player"
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
    'font-pixel text-sm sm:text-base flex items-center justify-center transition disabled:opacity-30 disabled:cursor-not-allowed rounded-xs border'
  const variant = primary
    ? 'w-10 h-10 sm:w-11 sm:h-11 border-hot bg-hot/15 text-ink-hi shadow-[var(--shadow-glow-hot)] hover:bg-hot/25'
    : 'w-8 h-8 sm:w-9 sm:h-9 border-border text-ink-mid hover:text-cool hover:border-cool/70'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
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
      className={`w-9 h-9 font-pixel text-base ${hideOnMobile ? 'hidden sm:flex' : 'flex'} items-center justify-center transition rounded-xs border ${
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
        <button
          type="button"
          onClick={onClose}
          title="close"
          aria-label="close queue"
          className="font-pixel text-sm text-ink-lo hover:text-crit transition"
        >
          ✕
        </button>
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
