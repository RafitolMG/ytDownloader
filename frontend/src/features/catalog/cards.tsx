import type {
  ActivityItem,
  CatalogItem,
  Category,
  DailyMix,
  ExternalCatalogItem,
  LibraryItem,
} from '@/shared/api/types'
import { fmtDuration } from '@/shared/lib/format'
import { catalogToLibrary as toLibraryItem } from '@/shared/lib/libraryItem'
import { useAudioPlayer } from '@/features/player/AudioPlayerProvider'
import { useExternalDownload } from './useExternalDownload'
import { ACCENT, toPreviewItem } from './lib'

/** Compact card for the at-rest suggestions carousel. Same download flow as
 * ExternalRow, laid out vertically so a row of them scrolls horizontally. */
export function SuggestionCard({ item }: { item: ExternalCatalogItem }) {
  const dl = useExternalDownload(item)
  const player = useAudioPlayer()
  const isPreviewing =
    player.current?.video_id === item.video_id &&
    player.current?.codec === 'preview'

  return (
    <div className="group w-40 sm:w-44 flex-shrink-0 snap-start card-vapor rounded-sm overflow-hidden border border-border">
      <div className="relative aspect-video bg-page-mid">
        {item.thumbnail_url ? (
          <img
            src={item.thumbnail_url}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-violet/40 via-hot/20 to-cool/30" />
        )}
        {item.duration_sec != null && (
          <span className="absolute bottom-0.5 right-0.5 font-pixel text-[10px] leading-none bg-page/80 text-cool px-1 py-0.5 rounded-xs">
            {fmtDuration(item.duration_sec)}
          </span>
        )}
        {/* Preview play overlay. */}
        {!dl.started && (
          <button
            type="button"
            onClick={() =>
              isPreviewing ? player.togglePlay() : player.play([toPreviewItem(item)])
            }
            title="preview without downloading"
            className={`absolute inset-0 flex items-center justify-center text-2xl text-ink-hi bg-page/40 transition ${
              isPreviewing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            }`}
          >
            <span style={{ textShadow: '0 0 10px var(--color-hot)' }}>
              {isPreviewing && player.isPlaying ? '❚❚' : '▶'}
            </span>
          </button>
        )}
        {dl.started && !dl.isDone && (
          <div className="absolute inset-0 bg-page/70 flex items-center justify-center font-pixel text-xs text-cool tabular-nums">
            {dl.pct.toFixed(0)}%
          </div>
        )}
      </div>

      <div className="p-2">
        <div
          className="font-sans text-xs font-medium text-ink-hi leading-snug line-clamp-2 min-h-[2rem]"
          title={item.title ?? item.video_id}
        >
          {item.title ?? item.video_id}
        </div>
        <div className="text-xs text-ink-lo truncate mt-0.5 mb-2">
          {item.artist ?? '—'}
        </div>
        <button
          type="button"
          onClick={dl.start}
          disabled={dl.isPending || dl.isDone}
          title="download mp3 · 320 and add to the catalog"
          className={`w-full font-pixel text-xs uppercase tracking-widest flex items-center justify-center gap-1 px-2 py-1 border rounded-xs transition disabled:opacity-60 ${
            dl.isDone
              ? 'border-hot/60 text-hot bg-hot/10'
              : 'border-cool/60 text-cool hover:bg-cool/10 hover:shadow-[var(--shadow-glow-cool)]'
          }`}
        >
          {dl.isDone ? '✓ added' : dl.isPending ? '···' : '⬇ add'}
        </button>
        {dl.failed && (
          <div className="mt-1 font-pixel text-[10px] text-crit line-clamp-1">
            ⚠ {dl.failed}
          </div>
        )}
      </div>
    </div>
  )
}

/** Placeholder card shown while the Mixes load. */
export function SuggestionSkeleton() {
  return (
    <div className="w-40 sm:w-44 flex-shrink-0 card-vapor rounded-sm overflow-hidden border border-border animate-pulse">
      <div className="aspect-video bg-violet/10" />
      <div className="p-2 space-y-2">
        <div className="h-3 bg-violet/10 rounded-xs" />
        <div className="h-3 w-2/3 bg-violet/10 rounded-xs" />
        <div className="h-6 bg-violet/10 rounded-xs mt-2" />
      </div>
    </div>
  )
}

/** Square cover card for the recently-played strip; click plays from here. */
export function RecentCard({
  item,
  queue,
  index,
}: {
  item: CatalogItem
  queue: CatalogItem[]
  index: number
}) {
  const player = useAudioPlayer()
  return (
    <button
      type="button"
      onClick={() => player.play(queue.map(toLibraryItem), index)}
      className="w-32 sm:w-36 flex-shrink-0 snap-start text-left group"
      title={`${item.title ?? item.video_id} — ${item.artist ?? ''}`}
    >
      <div className="relative aspect-square rounded-sm overflow-hidden border border-border bg-page-mid">
        {item.thumbnail_url ? (
          <img
            src={item.thumbnail_url}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-violet/40 via-hot/20 to-cool/30" />
        )}
        <span className="absolute inset-0 flex items-center justify-center text-2xl text-ink-hi opacity-0 group-hover:opacity-100 bg-page/40 transition">
          ▶
        </span>
      </div>
      <div className="mt-1 font-sans text-xs font-medium text-ink-hi line-clamp-2 leading-snug">
        {item.title ?? item.video_id}
      </div>
      <div className="text-xs text-ink-lo truncate">{item.artist ?? '—'}</div>
    </button>
  )
}

/** Daily mix tile. Click the card to preview the tracklist; the ▶ badge plays
 * the whole mix straight away. */
export function DailyMixCard({ mix, onOpen }: { mix: DailyMix; onOpen: () => void }) {
  const player = useAudioPlayer()
  const a = ACCENT[mix.accent]
  const covers =
    mix.cover_urls?.length
      ? mix.cover_urls
      : mix.tracks[0]?.thumbnail_url
        ? [mix.tracks[0].thumbnail_url]
        : []
  const hasPlayable = mix.tracks.length > 0
  // A `discovery` mix has no downloaded tracks — quick-play streams previews of
  // its new-music picks through the preview proxy instead of the library.
  const playQueue = hasPlayable
    ? mix.tracks.map(toLibraryItem)
    : mix.external.map(toPreviewItem)
  return (
    <div
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onOpen()
      }}
      className={`group w-40 sm:w-44 flex-shrink-0 snap-start text-left cursor-pointer card-vapor rounded-sm overflow-hidden border ${a.border} transition ${a.glow}`}
      title={`${mix.title} · ${mix.subtitle} — preview`}
    >
      <div className={`relative aspect-square bg-gradient-to-br ${a.grad}`}>
        {covers.length >= 4 ? (
          <div className="absolute inset-0 grid grid-cols-2 grid-rows-2">
            {covers.slice(0, 4).map((url, i) => (
              <img
                key={i}
                src={url}
                alt=""
                className="w-full h-full object-cover opacity-60"
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ))}
          </div>
        ) : covers[0] ? (
          <img
            src={covers[0]}
            alt=""
            className="w-full h-full object-cover opacity-60"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : null}
        <span
          className={`absolute top-2 left-2 font-pixel text-xs uppercase tracking-widest ${a.text}`}
          style={{ textShadow: '0 0 8px currentColor' }}
        >
          {mix.title}
        </span>
        {playQueue.length > 0 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              player.play(playQueue, 0)
            }}
            title="play this mix"
            aria-label="play this mix"
            className="absolute bottom-2 right-2 w-9 h-9 flex items-center justify-center rounded-full bg-hot/80 text-ink-hi shadow-[var(--shadow-glow-hot)] opacity-0 group-hover:opacity-100 transition hover:bg-hot"
          >
            ▶
          </button>
        )}
      </div>
      <div className="p-2">
        <div className="font-sans text-xs font-medium text-ink-hi truncate">
          {mix.subtitle}
        </div>
        <div className="text-xs text-ink-lo tabular-nums">
          {hasPlayable
            ? `${mix.tracks.length} tracks`
            : `${mix.external.length} to discover`}
        </div>
      </div>
    </div>
  )
}

/** Browse grid tile for a curated category — gradient + title, no emoji
 * (keeps the pixel/vaporwave aesthetic clean). */
export function CategoryCard({
  category,
  onClick,
}: {
  category: Category
  onClick: () => void
}) {
  const a = ACCENT[category.accent]
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative h-20 rounded-sm overflow-hidden border ${a.border} bg-gradient-to-br ${a.grad} flex items-end p-3 transition ${a.glow} group`}
    >
      {/* faint scanline-ish texture corner glyph, accent-tinted */}
      <span
        className={`absolute -top-1 right-1 font-pixel text-3xl opacity-30 ${a.text} select-none`}
        aria-hidden
      >
        ▓▒░
      </span>
      <span className="relative font-pixel text-sm uppercase tracking-widest text-ink-hi">
        {category.title}
      </span>
    </button>
  )
}

/** One row in the activity feed: who added what. Click plays the feed from
 * here. */
export function ActivityRow({
  item,
  queue,
  index,
}: {
  item: ActivityItem
  queue: ActivityItem[]
  index: number
}) {
  const player = useAudioPlayer()
  const toLib = (a: ActivityItem): LibraryItem => ({
    video_id: a.video_id,
    codec: a.codec,
    bitrate: a.bitrate,
    title: a.title,
    artist: a.artist,
    duration_sec: a.duration_sec,
    thumbnail_url: a.thumbnail_url,
    source_url: a.source_url,
    file_size: a.file_size,
    added_at: a.added_at,
    source_playlist_title: null,
  })
  return (
    <li
      role="button"
      tabIndex={0}
      aria-label={`play ${item.title ?? item.video_id}`}
      onClick={() => player.play(queue.map(toLib), index)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          player.play(queue.map(toLib), index)
        }
      }}
      className="flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2 cursor-pointer hover:bg-violet/10 transition"
    >
      <div className="relative w-12 sm:w-14 aspect-video flex-shrink-0 rounded-xs overflow-hidden border border-border bg-page-mid">
        {item.thumbnail_url ? (
          <img
            src={item.thumbnail_url}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-violet/40 via-hot/20 to-cool/30" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-sans text-sm text-ink-hi truncate">
          {item.title ?? item.video_id}
        </div>
        <div className="text-xs text-ink-lo truncate">
          <span className="text-cool">{item.username ?? 'someone'}</span> added ·{' '}
          {item.artist ?? '—'}
        </div>
      </div>
    </li>
  )
}
