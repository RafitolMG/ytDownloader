import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useAudioPlayer } from './AudioPlayerProvider'
import { usePlaybackTime } from './playbackStore'
import { G } from '@/shared/ui/glyphs'
import { fmtTime } from '@/shared/lib/format'
import { hiResThumbnail, thumbnailFallback } from '@/shared/lib/thumbnail'
import { useBackClose } from '@/shared/lib/backStack'

/** Full-screen (mobile) / large centered (desktop) "now playing" surface:
 * big cover, full metadata, a tall seek bar, large transport, volume, and the
 * up-next queue. All state comes from the shared player — this is a richer view
 * of the same thing the PlayerBar shows. Portal'd above everything; Escape and
 * the ✕ close it; body scroll is locked while open. */
export function NowPlayingView({ onClose }: { onClose: () => void }) {
  const p = useAudioPlayer()
  const { position, duration } = usePlaybackTime()
  useBackClose(true, onClose)

  // Swipe the cover left → next, right → previous. Attached to the artwork only
  // (not the whole view) so it never fights the seek bar or vertical scroll.
  const swipeRef = useRef<{ x: number; y: number } | null>(null)
  const onCoverTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0]
    swipeRef.current = { x: t.clientX, y: t.clientY }
  }
  const onCoverTouchEnd = (e: React.TouchEvent) => {
    const s = swipeRef.current
    swipeRef.current = null
    if (!s) return
    const t = e.changedTouches[0]
    const dx = t.clientX - s.x
    const dy = t.clientY - s.y
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) p.next()
      else p.prev()
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  const t = p.current
  if (!t) return null
  const dur = Number.isFinite(duration) ? duration : t.duration_sec ?? 0
  const pct = dur > 0 ? Math.min(100, (position / dur) * 100) : 0
  const year = t.release_year ?? null
  const subtitle = [t.artist ?? '—', t.album, year].filter(Boolean).join(' · ')

  return createPortal(
    <div className="fixed inset-0 z-[80] flex flex-col bg-page/95 backdrop-blur-md overflow-y-auto pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      {/* header */}
      <div className="flex items-center justify-between px-4 sm:px-6 py-4 flex-shrink-0">
        <span className="font-pixel text-xs uppercase tracking-[0.3em] text-cool">
          ░▒▓ now playing ▓▒░
        </span>
        <button
          type="button"
          onClick={onClose}
          title="close"
          aria-label="close now playing"
          className="focus-vis font-pixel text-base w-9 h-9 flex items-center justify-center border border-border text-ink-mid hover:text-crit hover:border-crit/60 transition rounded-xs"
        >
          {G.close}
        </button>
      </div>

      <div className="flex-1 w-full max-w-2xl mx-auto px-4 sm:px-6 pb-8 flex flex-col">
        {/* cover */}
        <div
          onTouchStart={onCoverTouchStart}
          onTouchEnd={onCoverTouchEnd}
          className="relative w-full max-w-sm mx-auto aspect-square rounded-sm overflow-hidden border border-violet/40 bg-page-mid shadow-[var(--shadow-glow-cool)] mt-2 mb-6 select-none"
        >
          {t.thumbnail_url ? (
            <img
              src={p.coverUrl ?? hiResThumbnail(t.thumbnail_url) ?? undefined}
              onError={(e) => thumbnailFallback(e, t.thumbnail_url)}
              onLoad={(e) => thumbnailFallback(e, t.thumbnail_url)}
              alt=""
              className="w-full h-full object-cover"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-violet/40 via-hot/20 to-cool/30" />
          )}
        </div>

        {/* title + meta */}
        <div className="text-center mb-5 min-w-0">
          <div className="font-sans text-xl sm:text-2xl font-semibold text-ink-hi leading-tight line-clamp-2">
            {t.title ?? t.video_id}
          </div>
          <div className="font-sans text-sm text-ink-mid mt-1 truncate">{subtitle}</div>
        </div>

        {/* seek */}
        <div className="mb-5">
          <div
            role="slider"
            tabIndex={0}
            aria-label="seek"
            aria-valuemin={0}
            aria-valuemax={Math.floor(dur)}
            aria-valuenow={Math.floor(position)}
            aria-valuetext={`${fmtTime(position)} of ${fmtTime(dur)}`}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') p.seek(Math.max(0, position - 5))
              else if (e.key === 'ArrowRight') p.seek(position + 5)
            }}
            className="focus-vis relative h-2 rounded-xs bg-page-mid cursor-pointer group"
            onClick={(e) => {
              if (dur <= 0) return
              const r = e.currentTarget.getBoundingClientRect()
              p.seek(((e.clientX - r.left) / r.width) * dur)
            }}
          >
            <div
              className="absolute inset-y-0 left-0 rounded-xs bg-gradient-to-r from-violet via-hot to-cool"
              style={{ width: `${pct}%` }}
            />
            <div
              className="absolute inset-y-0 w-3 -ml-1.5 bg-ink-hi rounded-xs shadow-[var(--shadow-glow-hot)] opacity-0 group-hover:opacity-100 transition"
              style={{ left: `${pct}%` }}
            />
          </div>
          <div className="flex justify-between font-pixel text-xs text-ink-lo tabular-nums mt-1">
            <span>{fmtTime(position)}</span>
            <span>{fmtTime(dur)}</span>
          </div>
        </div>

        {/* transport */}
        <div className="flex items-center justify-center gap-3 sm:gap-4 mb-6">
          <NPToggle onClick={p.toggleShuffle} active={p.shuffle} title="shuffle">
            {G.shuffle}
          </NPToggle>
          <NPButton
            onClick={p.prev}
            disabled={!p.canGoPrev && position < 3}
            title="previous"
          >
            {G.prev}
          </NPButton>
          <button
            type="button"
            onClick={p.togglePlay}
            title={p.isPlaying ? 'pause' : 'play'}
            aria-label={p.isPlaying ? 'pause' : 'play'}
            className="focus-vis w-16 h-16 flex items-center justify-center rounded-full border border-hot bg-hot/15 text-ink-hi text-xl shadow-[var(--shadow-glow-hot)] hover:bg-hot/25 transition"
          >
            {p.isPlaying ? G.pause : G.play}
          </button>
          <NPButton onClick={p.next} disabled={!p.canGoNext} title="next">
            {G.next}
          </NPButton>
          <NPToggle
            onClick={p.cycleRepeat}
            active={p.repeat !== 'off'}
            title={`repeat: ${p.repeat}`}
          >
            {p.repeat === 'one' ? G.repeatOne : G.repeat}
          </NPToggle>
        </div>

        {/* volume — desktop only (phones use hardware buttons) */}
        <div className="hidden sm:flex items-center gap-3 justify-center mb-8">
          <button
            type="button"
            onClick={() => p.setVolume(p.volume > 0 ? 0 : 1)}
            title={p.volume > 0 ? 'mute' : 'unmute'}
            aria-label={p.volume > 0 ? 'mute' : 'unmute'}
            className={`hidden sm:inline focus-vis font-pixel text-base w-6 text-center ${
              p.volume === 0 ? 'text-crit' : 'text-ink-lo hover:text-cool'
            }`}
          >
            {p.volume === 0 ? G.mute : G.volume}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={p.volume}
            onChange={(e) => p.setVolume(Number(e.target.value))}
            aria-label="volume"
            className="hidden sm:block focus-vis w-40 accent-[var(--color-cool)] cursor-pointer"
          />
        </div>

        {/* up next */}
        {p.orderedQueue.length > 1 && (
          <div>
            <div className="font-pixel text-xs uppercase tracking-[0.2em] text-cool mb-2">
              ░ up next ░
            </div>
            <ul className="card-vapor rounded-sm divide-y divide-border">
              {p.orderedQueue.map(({ track, orderPos, isCurrent }) => (
                <li
                  key={`${orderPos}/${track.video_id}`}
                  className={`flex items-center gap-2 px-3 py-2 transition ${
                    isCurrent ? 'bg-hot/10' : 'hover:bg-violet/10'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => p.jumpTo(orderPos)}
                    className="focus-vis flex items-center gap-2 min-w-0 flex-1 text-left"
                    title="play"
                  >
                    <span className="font-pixel text-xs w-5 text-center text-ink-lo">
                      {isCurrent ? <span className="text-hot">{G.play}</span> : orderPos + 1}
                    </span>
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
                      aria-label="remove from queue"
                      className="focus-vis font-pixel text-sm w-6 h-6 flex items-center justify-center text-ink-lo hover:text-crit transition"
                    >
                      {G.close}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

function NPButton({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="focus-vis w-11 h-11 flex items-center justify-center rounded-xs border border-border text-ink-mid hover:text-cool hover:border-cool/70 transition disabled:opacity-30 disabled:cursor-not-allowed font-pixel text-base"
    >
      {children}
    </button>
  )
}

function NPToggle({
  children,
  onClick,
  active,
  title,
}: {
  children: React.ReactNode
  onClick: () => void
  active: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`focus-vis w-10 h-10 flex items-center justify-center rounded-xs border font-pixel text-base transition ${
        active
          ? 'border-cool text-cool bg-cool/10 shadow-[var(--shadow-glow-cool)]'
          : 'border-border text-ink-lo hover:text-cool hover:border-cool/70'
      }`}
    >
      {children}
    </button>
  )
}
