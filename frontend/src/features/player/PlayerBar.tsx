import { useAudioPlayer } from './AudioPlayerProvider'

export function PlayerBar() {
  const p = useAudioPlayer()
  if (!p.current) return null

  const t = p.current
  const dur = Number.isFinite(p.duration) ? p.duration : t.duration_sec ?? 0
  const pct = dur > 0 ? Math.min(100, (p.position / dur) * 100) : 0

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-page-mid shadow-[0_-8px_32px_rgba(0,0,0,0.6)]">
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
            <div className="text-xs text-ink-lo truncate">{t.artist ?? '—'}</div>
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
            ⏮
          </PlayerButton>
          <PlayerButton onClick={p.togglePlay} primary title={p.isPlaying ? 'pause' : 'play'}>
            {p.isPlaying ? '❚❚' : '▶'}
          </PlayerButton>
          <PlayerButton
            onClick={p.next}
            disabled={!p.canGoNext}
            title="next"
          >
            ⏭
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

        {/* Time */}
        <div className="hidden sm:block font-pixel text-sm text-ink-lo tabular-nums min-w-[5.5rem] text-right">
          {fmtTime(p.position)} / {fmtTime(dur)}
        </div>

        {/* Queue position + close */}
        <div className="flex items-center gap-2">
          {p.queue.length > 1 && (
            <span className="hidden md:inline font-pixel text-xs text-ink-lo uppercase tracking-widest">
              {p.index + 1}/{p.queue.length}
            </span>
          )}
          <button
            type="button"
            onClick={p.stop}
            className="font-pixel text-sm uppercase tracking-widest px-2 py-1 border border-ink-lo/50 text-ink-lo hover:text-crit hover:border-crit/60 transition rounded-xs"
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

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
