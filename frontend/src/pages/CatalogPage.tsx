import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { AppHeader } from '@/shared/ui/AppHeader'
import { api } from '@/shared/api/client'
import type {
  CatalogItem,
  CatalogSort,
  ExternalCatalogItem,
  LibraryItem,
} from '@/shared/api/types'
import { countActive, useJobs } from '@/shared/api/useJobs'
import { useAudioPlayer } from '@/features/player/AudioPlayerProvider'
import { useLiveJobProgress } from '@/features/queue/useLiveJobProgress'
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

/** Tiny debounce so each keystroke doesn't trigger a ytsearch round-trip.
 * 400ms keeps typing feedback fast while letting bursts settle. */
function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}

export default function CatalogPage() {
  const jobsQuery = useJobs()
  const activeCount = countActive(jobsQuery.data)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<CatalogSort>('newest')

  const trimmed = query.trim()
  const debouncedQuery = useDebouncedValue(trimmed, 400)
  const isSearching = debouncedQuery.length > 0

  // Two parallel queries; only one is "enabled" at a time. The catalog query
  // (no q) drives the idle browse + sort buttons. The discover query (with q)
  // returns DB hits plus external candidates from ytsearch.
  const catalogQuery = useQuery({
    queryKey: ['catalog', { sort }],
    queryFn: () => api.catalog({ sort, limit: 300 }),
    enabled: !isSearching,
    staleTime: 10_000,
  })
  const discoverQuery = useQuery({
    queryKey: ['discover', { q: debouncedQuery }],
    queryFn: () => api.discover({ q: debouncedQuery, limit: 60, external_limit: 12 }),
    enabled: isSearching,
    // ytsearch is cached server-side already; keep the client side cool too
    // so re-typing the same query doesn't ping again.
    staleTime: 30_000,
  })

  const dbItems: CatalogItem[] = isSearching
    ? discoverQuery.data?.db ?? []
    : catalogQuery.data?.items ?? []
  const externals: ExternalCatalogItem[] = isSearching
    ? discoverQuery.data?.external ?? []
    : []

  const activeQuery = isSearching ? discoverQuery : catalogQuery
  const showEmpty =
    activeQuery.data !== undefined &&
    dbItems.length === 0 &&
    externals.length === 0

  return (
    <div className="relative z-10 min-h-full">
      <main className="max-w-6xl mx-auto px-3 sm:px-6 py-4 sm:py-8 pb-32">
        <AppHeader queueCount={activeCount} />

        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div className="font-pixel text-xs text-ink-lo uppercase tracking-[0.2em]">
            ░▒▓ shared catalog ▓▒░
          </div>
          {/* Sort only matters when browsing — search uses popularity. Hide
              the chips while searching so the user doesn't pick a sort that
              quietly does nothing. */}
          {!isSearching && (
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
          )}
        </div>

        <div className="card-vapor rounded-sm p-3 mb-6 flex items-center gap-3 font-pixel">
          <span className="text-cool text-xl">⌕</span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search the catalog and youtube..."
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

        {activeQuery.isLoading && (
          <div className="font-pixel text-ink-mid">··· loading catalog ···</div>
        )}
        {activeQuery.isError && (
          <div className="font-pixel text-crit">
            failed to load:{' '}
            {activeQuery.error instanceof Error ? activeQuery.error.message : 'unknown'}
          </div>
        )}
        {showEmpty && (
          <div className="card-vapor rounded-sm p-8 text-center">
            <div className="font-pixel text-lg text-ink-mid mb-2">
              ⊹ nothing found ⊹
            </div>
            <div className="font-pixel text-sm text-ink-lo">
              {isSearching
                ? `nothing in the catalog or on youtube matches "${debouncedQuery}"`
                : 'no tracks have been downloaded yet.'}
            </div>
          </div>
        )}

        {dbItems.length > 0 && (
          <ul className="card-vapor rounded-sm divide-y divide-border">
            {dbItems.map((it, idx) => (
              <CatalogRow
                key={`${it.video_id}/${it.codec}/${it.bitrate}`}
                item={it}
                position={idx + 1}
                allItems={dbItems}
              />
            ))}
          </ul>
        )}

        {externals.length > 0 && (
          <>
            <div className="mt-6 mb-3 flex items-center gap-3 font-pixel text-xs text-ink-lo uppercase tracking-[0.2em]">
              <span className="flex-1 border-t border-border" />
              <span>↓ found on youtube · not yet downloaded</span>
              <span className="flex-1 border-t border-border" />
            </div>
            <ul className="card-vapor rounded-sm divide-y divide-border">
              {externals.map((ext, idx) => (
                <ExternalRow
                  key={ext.video_id}
                  item={ext}
                  position={dbItems.length + idx + 1}
                  invalidateKey={debouncedQuery}
                />
              ))}
            </ul>
          </>
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
      queryClient.invalidateQueries({ queryKey: ['discover'] })
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
      className={`flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2 cursor-pointer transition group ${
        isCurrent ? 'bg-hot/10' : 'hover:bg-violet/10'
      }`}
    >
      <div className="font-pixel text-xs sm:text-sm text-ink-lo w-6 sm:w-8 text-right tabular-nums">
        {isCurrent && player.isPlaying ? (
          <span className="text-hot">▶</span>
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

/** Row for a YouTube candidate not yet in the catalog. Clicking ⬇ fires a
 * library import (mp3-320 — the catalog's canonical bitrate) and subscribes
 * to the job's progress WS. On completion the catalog and discover queries
 * are invalidated so the row re-renders as a CatalogRow on the next fetch. */
function ExternalRow({
  item,
  position,
  invalidateKey,
}: {
  item: ExternalCatalogItem
  position: number
  invalidateKey: string
}) {
  const queryClient = useQueryClient()
  const [jobId, setJobId] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  const live = useLiveJobProgress(jobId ?? '', jobId !== null)

  const download = useMutation({
    mutationFn: () =>
      api.download({
        url: item.source_url,
        format_code: 'mp3-320',
        as_file: false,
      }),
    onSuccess: ({ job_id }) => {
      setJobId(job_id)
      setFailed(null)
    },
    onError: (e) => setFailed(e instanceof Error ? e.message : 'download failed'),
  })

  // The hook closes its WS and emits 'done' / 'error' through query
  // invalidation; reacting to the status here lets us flip the row UI
  // immediately and refresh the catalog so a freshly-downloaded track
  // shows up as a real DB row.
  useEffect(() => {
    if (live.status === 'done') {
      queryClient.invalidateQueries({ queryKey: ['discover'] })
      queryClient.invalidateQueries({ queryKey: ['catalog'] })
      queryClient.invalidateQueries({ queryKey: ['library'] })
    } else if (live.status === 'error') {
      setFailed('download failed — check the queue')
    }
  }, [live.status, queryClient, invalidateKey])

  const isPending = download.isPending || (jobId !== null && live.status !== 'done' && live.status !== 'error')
  const pct = live.progress ?? 0

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
        {jobId && live.status !== 'done' && (
          <div className="mt-1 font-pixel text-xs text-cool tabular-nums">
            ··· downloading {pct.toFixed(0)}%
          </div>
        )}
        {failed && (
          <div className="mt-1 font-pixel text-xs text-crit">⚠ {failed}</div>
        )}
      </div>

      <button
        type="button"
        onClick={() => {
          if (!isPending) download.mutate()
        }}
        disabled={isPending}
        title="download mp3 · 320 and add to the catalog"
        className="font-pixel text-sm flex items-center gap-1 px-2 py-1 border rounded-xs transition disabled:opacity-50 border-cool/60 text-cool hover:bg-cool/10 hover:shadow-[var(--shadow-glow-cool)]"
      >
        {isPending ? '···' : '⬇'}
      </button>
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
