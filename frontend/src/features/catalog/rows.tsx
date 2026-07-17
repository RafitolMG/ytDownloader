import { memo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/shared/api/client'
import type { CatalogItem, ExternalCatalogItem } from '@/shared/api/types'
import { fmtDuration } from '@/shared/lib/format'
import { catalogToLibrary as toLibraryItem } from '@/shared/lib/libraryItem'
import { useAudioPlayer } from '@/features/player/AudioPlayerProvider'
import { AddToPlaylistMenu } from '@/features/playlists/AddToPlaylistMenu'
import { NowPlayingTick } from '@/shared/ui/NowPlayingTick'
import { useToast } from '@/shared/ui/ToastProvider'
import { useRadio } from './RadioContext'
import { useExternalDownload } from './useExternalDownload'
import { toPreviewItem } from './lib'

// Memoized: in the 300-row full catalog, a parent re-render that doesn't change
// a row's props (item/position/allItems are referentially stable per query)
// skips re-rendering that row.
export const CatalogRow = memo(function CatalogRow({
  item,
  position,
  allItems,
}: {
  item: CatalogItem
  position: number
  allItems: CatalogItem[]
}) {
  const player = useAudioPlayer()
  const queryClient = useQueryClient()
  const openRadio = useRadio()
  const showToast = useToast()

  const toggleLibrary = useMutation({
    // The two branches return different literal `owned` types; widen to a
    // common shape so the ternary doesn't force the mutation type into one
    // arm (`owned: true`) and reject the other under `tsc -b`.
    mutationFn: async (): Promise<{ ok: true; owned: boolean }> =>
      item.is_owned
        ? api.catalogUnown(item.video_id, item.codec, item.bitrate)
        : api.catalogAdopt(item.video_id, item.codec, item.bitrate),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['catalog'] })
      queryClient.invalidateQueries({ queryKey: ['discover'] })
      queryClient.invalidateQueries({ queryKey: ['library'] })
    },
    onError: () =>
      showToast({
        message: item.is_owned ? "couldn't remove from your library" : "couldn't save to your library",
        variant: 'err',
      }),
  })

  const isCurrent =
    player.current?.video_id === item.video_id &&
    player.current?.codec === item.codec &&
    player.current?.bitrate === item.bitrate

  function handlePlay() {
    // Play the whole current catalog view starting at this row — encourages
    // discovery and lines up with how playlist play works elsewhere.
    const queue = allItems.map(toLibraryItem)
    const startAt = allItems.findIndex(
      (i) =>
        i.video_id === item.video_id &&
        i.codec === item.codec &&
        i.bitrate === item.bitrate,
    )
    player.play(queue, Math.max(0, startAt))
  }

  return (
    <li
      role="button"
      tabIndex={0}
      aria-label={`play ${item.title ?? item.video_id}`}
      onClick={handlePlay}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handlePlay()
        }
      }}
      className={`flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2.5 sm:py-3 cursor-pointer transition group ${
        isCurrent ? 'bg-hot/10' : 'hover:bg-violet/10'
      }`}
    >
      <div className="font-pixel text-xs sm:text-sm text-ink-lo w-6 sm:w-8 text-right tabular-nums">
        {isCurrent ? (
          <NowPlayingTick playing={player.isPlaying} />
        ) : (
          String(position).padStart(2, '0')
        )}
      </div>

      <div className="relative w-14 sm:w-20 aspect-video flex-shrink-0 rounded-xs overflow-hidden border border-border bg-page-mid">
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
      </div>

      <div className="flex-1 min-w-0">
        <div className="font-sans text-sm font-medium text-ink-hi leading-snug line-clamp-2">
          {item.title ?? item.video_id}
        </div>
        <div className="text-sm text-ink-mid truncate mt-0.5">
          {item.artist ?? '—'}
          {item.album ? <span className="text-ink-mid/70"> · {item.album}</span> : null}
        </div>
      </div>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          if (!toggleLibrary.isPending) toggleLibrary.mutate()
        }}
        disabled={toggleLibrary.isPending}
        title={
          item.is_owned
            ? 'remove from your library'
            : 'save to your library — no re-download'
        }
        className={`font-pixel text-base flex items-center gap-1 px-2.5 py-2 border rounded-xs transition disabled:opacity-30 ${
          item.is_owned
            ? 'border-hot text-hot bg-hot/10 shadow-[var(--shadow-glow-hot)]'
            : 'border-border text-ink-lo hover:text-hot hover:border-hot/60'
        }`}
      >
        <span>{item.is_owned ? '♥' : '♡'}</span>
        <span className="tabular-nums">{item.owner_count}</span>
      </button>

      <AddToPlaylistMenu
        trackKey={{
          video_id: item.video_id,
          codec: item.codec,
          bitrate: item.bitrate,
        }}
        track={toLibraryItem(item)}
        onRadio={openRadio ? () => openRadio(item) : undefined}
        trigger={(open) => (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              open()
            }}
            title="add to playlist"
            className="font-pixel text-base w-10 h-10 flex items-center justify-center border border-border text-ink-mid hover:text-cool hover:border-cool/60 transition rounded-xs"
          >
            ≣+
          </button>
        )}
      />
    </li>
  )
})

/** "Download all" for a batch of YouTube candidates (a mix / category / radio
 * tail). Fires every download at once — each call just enqueues a background
 * job and returns immediately — then refreshes the catalog views. Per-row
 * progress lives in the queue; here we only show how many were queued. */
export function DownloadAllButton({
  items,
  own,
}: {
  items: ExternalCatalogItem[]
  /** false → add to the catalog without favouriting (daily-mix tracks). */
  own?: boolean
}) {
  const queryClient = useQueryClient()
  const [queued, setQueued] = useState(0)
  const [failed, setFailed] = useState(false)

  const dl = useMutation({
    mutationFn: async () => {
      const results = await Promise.allSettled(
        items.map((it) =>
          api.download({
            url: it.source_url,
            format_code: 'mp3-320',
            as_file: false,
            own: own ?? true,
          }),
        ),
      )
      return results.filter((r) => r.status === 'fulfilled').length
    },
    onSuccess: (ok) => {
      setQueued(ok)
      setFailed(ok < items.length)
      queryClient.invalidateQueries({ queryKey: ['discover'] })
      queryClient.invalidateQueries({ queryKey: ['catalog'] })
      queryClient.invalidateQueries({ queryKey: ['daily-mixes'] })
      queryClient.invalidateQueries({ queryKey: ['library'] })
      queryClient.invalidateQueries({ queryKey: ['activity'] })
    },
    onError: () => setFailed(true),
  })

  return (
    <button
      type="button"
      onClick={() => {
        if (!dl.isPending) dl.mutate()
      }}
      disabled={dl.isPending || queued > 0}
      title="download every track below to the catalog"
      className="font-pixel text-xs uppercase tracking-widest px-3 py-1 border border-cool/60 text-cool hover:bg-cool/10 hover:shadow-[var(--shadow-glow-cool)] disabled:opacity-50 transition rounded-xs whitespace-nowrap"
    >
      {dl.isPending
        ? '··· queueing'
        : queued > 0
          ? `✓ queued ${queued}${failed ? ' (some failed)' : ''}`
          : `⬇ download all (${items.length})`}
    </button>
  )
}

/** Full-width list row for a YouTube candidate — used in the search results
 * ("found on youtube") section. */
export const ExternalRow = memo(function ExternalRow({
  item,
  position,
  own,
}: {
  item: ExternalCatalogItem
  position: number
  /** false → download to the catalog without favouriting (daily-mix tracks). */
  own?: boolean
}) {
  const dl = useExternalDownload(item, { own })
  const player = useAudioPlayer()
  const isPreviewing =
    player.current?.video_id === item.video_id &&
    player.current?.codec === 'preview'

  return (
    <li className="flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2 transition opacity-90">
      <div className="font-pixel text-xs sm:text-sm text-ink-lo w-6 sm:w-8 text-right tabular-nums">
        {String(position).padStart(2, '0')}
      </div>

      <div className="relative w-14 sm:w-20 aspect-video flex-shrink-0 rounded-xs overflow-hidden border border-border bg-page-mid">
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
      </div>

      <div className="flex-1 min-w-0">
        <div className="font-sans text-sm font-medium text-ink-hi leading-snug line-clamp-2">
          {item.title ?? item.video_id}
        </div>
        <div className="text-sm text-ink-lo truncate mt-0.5">
          {item.artist ?? '—'}
        </div>
        {dl.started && !dl.isDone && (
          <div className="mt-1 font-pixel text-xs text-cool tabular-nums">
            ··· downloading {dl.pct.toFixed(0)}%
          </div>
        )}
        {dl.failed && (
          <div className="mt-1 font-pixel text-xs text-crit">⚠ {dl.failed}</div>
        )}
      </div>

      <button
        type="button"
        onClick={() =>
          isPreviewing ? player.togglePlay() : player.play([toPreviewItem(item)])
        }
        aria-label={isPreviewing ? 'stop preview' : 'preview'}
        title="preview without downloading"
        className={`font-pixel text-sm w-9 h-9 flex items-center justify-center border rounded-xs transition ${
          isPreviewing
            ? 'border-hot text-hot bg-hot/10 shadow-[var(--shadow-glow-hot)]'
            : 'border-border text-ink-mid hover:text-hot hover:border-hot/60'
        }`}
      >
        {isPreviewing && player.isPlaying ? '❚❚' : '▶'}
      </button>

      <button
        type="button"
        onClick={dl.start}
        disabled={dl.isPending}
        aria-label="download to catalog"
        title="download mp3 · 320 and add to the catalog"
        className="font-pixel text-sm flex items-center gap-1 px-2 py-1 border rounded-xs transition disabled:opacity-50 border-cool/60 text-cool hover:bg-cool/10 hover:shadow-[var(--shadow-glow-cool)]"
      >
        {dl.isPending ? '···' : '⬇'}
      </button>
    </li>
  )
})
