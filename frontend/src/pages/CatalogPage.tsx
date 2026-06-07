import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { AppHeader } from '@/shared/ui/AppHeader'
import { api } from '@/shared/api/client'
import type { CatalogItem, CatalogSort, LibraryItem } from '@/shared/api/types'
import { countActive, useJobs } from '@/shared/api/useJobs'
import { useAudioPlayer } from '@/features/player/AudioPlayerProvider'
import { AddToPlaylistMenu } from '@/features/playlists/AddToPlaylistMenu'

/** Map a catalog row to the shape the audio player expects. The two types
 * differ in metadata (catalog has like/owner counts, library has added_at)
 * but the player only cares about identity + display fields. */
function toLibraryItem(c: CatalogItem): LibraryItem {
  return {
    video_id: c.video_id,
    codec: c.codec,
    bitrate: c.bitrate,
    title: c.title,
    artist: c.artist,
    duration_sec: c.duration_sec,
    thumbnail_url: c.thumbnail_url,
    source_url: c.source_url,
    file_size: c.file_size,
    added_at: c.downloaded_at,
    source_playlist_title: null,
  }
}

const SORT_LABELS: Record<CatalogSort, string> = {
  newest: 'newest',
  popular: '♥ most saved',
  title: 'title a→z',
  artist: 'artist a→z',
}

export default function CatalogPage() {
  const jobsQuery = useJobs()
  const activeCount = countActive(jobsQuery.data)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<CatalogSort>('newest')

  const trimmed = query.trim()
  const catalogQuery = useQuery({
    queryKey: ['catalog', { q: trimmed, sort }],
    queryFn: () => api.catalog({ q: trimmed || undefined, sort, limit: 300 }),
    staleTime: 10_000,
  })
  const items = catalogQuery.data?.items ?? []

  return (
    <div className="relative z-10 min-h-full">
      <main className="max-w-6xl mx-auto px-6 py-8 pb-32">
        <AppHeader queueCount={activeCount} />

        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div className="font-pixel text-xs text-ink-lo uppercase tracking-[0.2em]">
            ░▒▓ shared catalog ▓▒░
          </div>
          <div className="flex items-center gap-2">
            {(Object.keys(SORT_LABELS) as CatalogSort[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSort(s)}
                className={`font-pixel text-xs uppercase tracking-widest px-2 py-1 border rounded-xs transition ${
                  sort === s
                    ? 'border-cool text-cool bg-cool/10 shadow-[var(--shadow-glow-cool)]'
                    : 'border-border text-ink-lo hover:text-cool hover:border-cool/70'
                }`}
              >
                {SORT_LABELS[s]}
              </button>
            ))}
          </div>
        </div>

        <div className="card-vapor rounded-sm p-3 mb-6 flex items-center gap-3 font-pixel">
          <span className="text-cool text-xl">⌕</span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search the catalog..."
            spellCheck={false}
            autoComplete="off"
            className="flex-1 bg-transparent border-none outline-none text-ink-hi placeholder:text-ink-lo text-lg caret-cool"
          />
          {trimmed && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="text-sm uppercase tracking-widest px-2 py-1 border border-ink-lo/50 text-ink-lo hover:text-crit hover:border-crit/60 transition rounded-xs"
              title="clear search"
            >
              ✕
            </button>
          )}
        </div>

        {catalogQuery.isLoading && (
          <div className="font-pixel text-ink-mid">··· loading catalog ···</div>
        )}
        {catalogQuery.isError && (
          <div className="font-pixel text-crit">
            failed to load catalog:{' '}
            {catalogQuery.error instanceof Error ? catalogQuery.error.message : 'unknown'}
          </div>
        )}
        {catalogQuery.data && items.length === 0 && (
          <div className="card-vapor rounded-sm p-8 text-center">
            <div className="font-pixel text-lg text-ink-mid mb-2">
              ⊹ empty catalog ⊹
            </div>
            <div className="font-pixel text-sm text-ink-lo">
              {trimmed
                ? `no tracks match "${trimmed}"`
                : 'no tracks have been downloaded yet.'}
            </div>
          </div>
        )}

        {items.length > 0 && (
          <ul className="card-vapor rounded-sm divide-y divide-border">
            {items.map((it, idx) => (
              <CatalogRow
                key={`${it.video_id}/${it.codec}/${it.bitrate}`}
                item={it}
                position={idx + 1}
                allItems={items}
              />
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}

function CatalogRow({
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
      queryClient.invalidateQueries({ queryKey: ['library'] })
    },
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
      onClick={handlePlay}
      className={`flex items-center gap-3 px-3 py-2 cursor-pointer transition group ${
        isCurrent ? 'bg-hot/10' : 'hover:bg-violet/10'
      }`}
    >
      <div className="font-pixel text-sm text-ink-lo w-8 text-right tabular-nums">
        {isCurrent && player.isPlaying ? (
          <span className="text-hot">▶</span>
        ) : (
          String(position).padStart(2, '0')
        )}
      </div>

      <div className="relative w-20 aspect-video flex-shrink-0 rounded-xs overflow-hidden border border-border bg-page-mid">
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
        className={`font-pixel text-sm flex items-center gap-1 px-2 py-1 border rounded-xs transition disabled:opacity-30 ${
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
        trigger={(open) => (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              open()
            }}
            title="add to playlist"
            className="font-pixel text-xs uppercase tracking-widest px-2 py-1 border border-border text-ink-lo hover:text-cool hover:border-cool/60 transition rounded-xs"
          >
            ≣+
          </button>
        )}
      />

    </li>
  )
}

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
