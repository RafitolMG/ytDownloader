import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useState } from 'react'
import { AppHeader } from '@/shared/ui/AppHeader'
import { api } from '@/shared/api/client'
import type {
  ActivityItem,
  ArtistStat,
  CatalogAccent,
  CatalogItem,
  CatalogSort,
  Category,
  DailyMix,
  ExternalCatalogItem,
  LibraryItem,
} from '@/shared/api/types'
import { countActive, useJobs } from '@/shared/api/useJobs'
import { useAudioPlayer } from '@/features/player/AudioPlayerProvider'
import { useLiveJobProgress } from '@/features/queue/useLiveJobProgress'
import { AddToPlaylistMenu } from '@/features/playlists/AddToPlaylistMenu'
import { NowPlayingTick } from '@/shared/ui/NowPlayingTick'

/** Map a catalog row to the shape the audio player expects. The two types
 * differ in metadata (catalog has like/owner counts, library has added_at)
 * but the player only cares about identity + display fields. */
export function toLibraryItem(c: CatalogItem): LibraryItem {
  return {
    video_id: c.video_id,
    codec: c.codec,
    bitrate: c.bitrate,
    title: c.title,
    artist: c.artist,
    album: c.album,
    album_artist: c.album_artist,
    release_year: c.release_year,
    duration_sec: c.duration_sec,
    thumbnail_url: c.thumbnail_url,
    source_url: c.source_url,
    file_size: c.file_size,
    added_at: c.downloaded_at,
    source_playlist_title: null,
  }
}

/** Map an external (undownloaded) candidate to a player item that streams via
 * the preview proxy. The sentinel codec 'preview' tells the player to use
 * /api/preview/{id} instead of the library stream. */
export function toPreviewItem(e: ExternalCatalogItem): LibraryItem {
  return {
    video_id: e.video_id,
    codec: 'preview',
    bitrate: '0',
    title: e.title,
    artist: e.artist,
    duration_sec: e.duration_sec,
    thumbnail_url: e.thumbnail_url,
    source_url: e.source_url,
    file_size: null,
    added_at: '',
    source_playlist_title: null,
  }
}

/** Lets any catalog row open a "more like this" radio without prop-drilling
 * the setter through every row/section. Provided by CatalogPage. */
const RadioCtx = createContext<((item: CatalogItem) => void) | null>(null)

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
  const player = useAudioPlayer()
  const jobsQuery = useJobs()
  const activeCount = countActive(jobsQuery.data)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<CatalogSort>('newest')
  // The full catalog is a long list and lives at the bottom of the browse
  // home; collapse it by default so its sort controls sit with the list (not
  // stranded at the top of the page) and don't bury the curated sections.
  const [catalogOpen, setCatalogOpen] = useState(false)
  // The catalog is pure discovery now — your saved tracks ("favourites") live
  // in Playlists → Liked Songs, not here.
  const isMine = false

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
  // At-rest discovery: YouTube Mix tracks related to the catalog's popular
  // songs that aren't downloaded yet. Only fetched while browsing (no query);
  // the seeding + mix fetch is slow, so cache it generously.
  // Suggestions are a discovery aid — only relevant when browsing the full
  // catalog ('all'), not while viewing your own library or searching.
  const suggestionsQuery = useQuery({
    queryKey: ['catalog-suggestions'],
    queryFn: () => api.suggestions({ limit: 18 }),
    enabled: !isSearching && !isMine,
    staleTime: 5 * 60_000,
  })

  // Browse "home" (Spotify-style): only when idle, scope=all, nothing drilled
  // into (no category or mix preview open).
  const [activeCategory, setActiveCategory] = useState<Category | null>(null)
  const [activeMix, setActiveMix] = useState<DailyMix | null>(null)
  const [activeRadio, setActiveRadio] = useState<CatalogItem | null>(null)
  const browseHome =
    !isSearching &&
    !isMine &&
    activeCategory === null &&
    activeMix === null &&
    activeRadio === null

  // Opening a radio is exclusive with the other drill-downs.
  const openRadio = (item: CatalogItem) => {
    setActiveCategory(null)
    setActiveMix(null)
    setActiveRadio(item)
  }

  const recentQuery = useQuery({
    queryKey: ['recent'],
    queryFn: () => api.recentPlays(20),
    enabled: browseHome,
    staleTime: 30_000,
  })
  const dailyMixesQuery = useQuery({
    queryKey: ['daily-mixes'],
    queryFn: () => api.dailyMixes(),
    enabled: browseHome,
    staleTime: 5 * 60_000,
  })
  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.categories(),
    enabled: browseHome,
    staleTime: 60 * 60_000,
  })
  const categoryFeedQuery = useQuery({
    queryKey: ['category', activeCategory?.slug],
    queryFn: () => api.category(activeCategory!.slug, { external_limit: 18 }),
    enabled: activeCategory !== null,
    staleTime: 60_000,
  })
  const radioQuery = useQuery({
    queryKey: ['radio', activeRadio?.video_id],
    queryFn: () => api.radio(activeRadio!.video_id, { external_limit: 18 }),
    enabled: activeRadio !== null,
    staleTime: 60_000,
  })
  const statsQuery = useQuery({
    queryKey: ['my-stats'],
    queryFn: () => api.myStats(30),
    enabled: browseHome,
    staleTime: 60_000,
  })
  const activityQuery = useQuery({
    queryKey: ['activity'],
    queryFn: () => api.activity(12),
    enabled: browseHome,
    staleTime: 30_000,
  })

  const recent = browseHome ? recentQuery.data?.items ?? [] : []
  const dailyMixes = browseHome ? dailyMixesQuery.data?.mixes ?? [] : []
  const categories = browseHome ? categoriesQuery.data?.categories ?? [] : []
  const topTracks = browseHome ? statsQuery.data?.top_tracks ?? [] : []
  const topArtists = browseHome ? statsQuery.data?.top_artists ?? [] : []
  const activity = browseHome ? activityQuery.data?.items ?? [] : []

  const dbItems: CatalogItem[] = isSearching
    ? discoverQuery.data?.db ?? []
    : catalogQuery.data?.items ?? []
  const externals: ExternalCatalogItem[] = isSearching
    ? discoverQuery.data?.external ?? []
    : []
  const suggestions: ExternalCatalogItem[] =
    isSearching || isMine ? [] : suggestionsQuery.data?.external ?? []

  const activeQuery = isSearching ? discoverQuery : catalogQuery
  const showEmpty =
    activeQuery.data !== undefined &&
    dbItems.length === 0 &&
    externals.length === 0

  return (
    <RadioCtx.Provider value={openRadio}>
    <div className="relative z-10 min-h-full">
      <main className="max-w-6xl mx-auto px-3 sm:px-6 py-4 sm:py-8 pb-32">
        <AppHeader queueCount={activeCount} />

        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div className="font-pixel text-xs text-ink-lo uppercase tracking-[0.2em]">
            ░▒▓ shared catalog ▓▒░
          </div>
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

        {activeRadio ? (
          <RadioView
            seed={activeRadio}
            feed={radioQuery.data}
            isLoading={radioQuery.isLoading}
            onBack={() => setActiveRadio(null)}
          />
        ) : activeCategory ? (
          <CategoryView
            category={activeCategory}
            feed={categoryFeedQuery.data}
            isLoading={categoryFeedQuery.isLoading}
            onBack={() => setActiveCategory(null)}
          />
        ) : activeMix ? (
          <MixView mix={activeMix} onBack={() => setActiveMix(null)} />
        ) : (
          <>
            {/* Spotify-style browse home: recently played, daily mixes and the
                category grid — only when idle on the full catalog. */}
            {browseHome && (
              <BrowseHome
                recent={recent}
                topTracks={topTracks}
                topArtists={topArtists}
                activity={activity}
                mixes={dailyMixes}
                mixesLoading={dailyMixesQuery.isLoading}
                personalized={dailyMixesQuery.data?.personalized ?? false}
                categories={categories}
                onOpenCategory={setActiveCategory}
                onOpenMix={setActiveMix}
              />
            )}

            {/* Suggestions carousel — discovery up top, not buried. Header +
                skeletons stay put while the Mixes load (~4s). */}
            {!isSearching && !isMine && (suggestionsQuery.isLoading || suggestions.length > 0) && (
              <section className="mb-8">
                <SectionHeader title="✦ suggestions for you" note="related to the catalog · not downloaded yet" />
                <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 snap-x">
                  {suggestionsQuery.isLoading && suggestions.length === 0
                    ? Array.from({ length: 8 }).map((_, i) => (
                        <SuggestionSkeleton key={i} />
                      ))
                    : suggestions.map((ext) => (
                        <SuggestionCard key={ext.video_id} item={ext} />
                      ))}
                </div>
              </section>
            )}

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
                    : isMine
                      ? 'your library is empty — tap ♡ on any catalog track to save it here.'
                      : 'no tracks have been downloaded yet.'}
                </div>
              </div>
            )}

            {dbItems.length > 0 && browseHome && (
              <section>
                {/* Collapsible "full catalog" submenu: the toggle, sort filters
                    and play-all all live right above the list they drive. */}
                <button
                  type="button"
                  onClick={() => setCatalogOpen((o) => !o)}
                  className="w-full mb-3 flex items-center gap-3 font-pixel text-xs text-cool uppercase tracking-[0.2em] hover:text-ink-hi transition"
                >
                  <span className="whitespace-nowrap">
                    {catalogOpen ? '▾' : '▸'} ▤ the full catalog
                  </span>
                  <span className="text-ink-lo normal-case tracking-normal tabular-nums">
                    {dbItems.length} tracks
                  </span>
                  <span className="flex-1 border-t border-border" />
                </button>

                {catalogOpen && (
                  <>
                    <div className="mb-3 flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={() => player.play(dbItems.map(toLibraryItem), 0)}
                        className="font-pixel text-xs uppercase tracking-widest px-3 py-1 border border-hot bg-hot/15 text-ink-hi shadow-[var(--shadow-glow-hot)] hover:bg-hot/25 transition rounded-xs"
                      >
                        ▶ play all
                      </button>
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
                  </>
                )}
              </section>
            )}

            {/* Search results (discover db hits) — no collapse, no sort: the
                query already ranks them and the list is short. */}
            {dbItems.length > 0 && !browseHome && (
              <section>
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
              </section>
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
                    />
                  ))}
                </ul>
              </>
            )}
          </>
        )}

      </main>
    </div>
    </RadioCtx.Provider>
  )
}

export function CatalogRow({
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
  const openRadio = useContext(RadioCtx)

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
}

/** Shared download lifecycle for a YouTube candidate (external row or
 * suggestion card): fire an mp3-320 library import, follow the job's progress
 * WS, and on completion invalidate the catalog views so the track re-renders
 * as a real DB row. Returns just the bits the UIs need to draw themselves. */
function useExternalDownload(item: ExternalCatalogItem, opts: { own?: boolean } = {}) {
  const own = opts.own ?? true
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
        own,
      }),
    onSuccess: ({ job_id }) => {
      setJobId(job_id)
      setFailed(null)
    },
    onError: (e) => setFailed(e instanceof Error ? e.message : 'download failed'),
  })

  const isDone = live.status === 'done'

  useEffect(() => {
    if (isDone) {
      queryClient.invalidateQueries({ queryKey: ['discover'] })
      queryClient.invalidateQueries({ queryKey: ['catalog'] })
      // Deliberately NOT invalidating ['catalog-suggestions'] here: the
      // suggestions carousel hosts this very card, so refetching it would yank
      // the card the moment its download finishes. The card shows its own
      // "✓ added" state instead and the carousel refreshes on its own staleTime.
      queryClient.invalidateQueries({ queryKey: ['daily-mixes'] })
      queryClient.invalidateQueries({ queryKey: ['library'] })
    } else if (live.status === 'error') {
      setFailed('download failed — check the queue')
    }
  }, [isDone, live.status, queryClient])

  const started = jobId !== null
  const isPending =
    download.isPending || (started && !isDone && live.status !== 'error')

  return {
    start: () => {
      if (!isPending) download.mutate()
    },
    isPending,
    isDone,
    started,
    pct: live.progress ?? 0,
    failed,
  }
}

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
export function ExternalRow({
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
        title="preview without downloading"
        className={`font-pixel text-sm w-8 h-8 flex items-center justify-center border rounded-xs transition ${
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
        title="download mp3 · 320 and add to the catalog"
        className="font-pixel text-sm flex items-center gap-1 px-2 py-1 border rounded-xs transition disabled:opacity-50 border-cool/60 text-cool hover:bg-cool/10 hover:shadow-[var(--shadow-glow-cool)]"
      >
        {dl.isPending ? '···' : '⬇'}
      </button>
    </li>
  )
}

/** Compact card for the at-rest suggestions carousel. Same download flow as
 * ExternalRow, laid out vertically so a row of them scrolls horizontally. */
function SuggestionCard({ item }: { item: ExternalCatalogItem }) {
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
function SuggestionSkeleton() {
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

// Accent → literal Tailwind classes (kept whole so the JIT sees them).
const ACCENT: Record<
  CatalogAccent,
  { border: string; text: string; grad: string; glow: string }
> = {
  hot: {
    border: 'border-hot/50',
    text: 'text-hot',
    grad: 'from-hot/40 via-violet/20 to-cool/20',
    glow: 'hover:shadow-[var(--shadow-glow-hot)]',
  },
  cool: {
    border: 'border-cool/50',
    text: 'text-cool',
    grad: 'from-cool/40 via-violet/20 to-hot/20',
    glow: 'hover:shadow-[var(--shadow-glow-cool)]',
  },
  violet: {
    border: 'border-violet/50',
    text: 'text-violet',
    grad: 'from-violet/40 via-hot/20 to-cool/20',
    glow: 'hover:shadow-[var(--shadow-glow-cool)]',
  },
}

function SectionHeader({ title, note }: { title: string; note?: string }) {
  return (
    <div className="mb-3 flex items-center gap-3 font-pixel text-xs text-cool uppercase tracking-[0.2em]">
      <span className="whitespace-nowrap">{title}</span>
      {note && (
        <span className="text-ink-lo normal-case tracking-normal truncate">{note}</span>
      )}
      <span className="flex-1 border-t border-border" />
    </div>
  )
}

/** The browse "home" shown when idle on the full catalog. */
function BrowseHome({
  recent,
  topTracks,
  topArtists,
  activity,
  mixes,
  mixesLoading,
  personalized,
  categories,
  onOpenCategory,
  onOpenMix,
}: {
  recent: CatalogItem[]
  topTracks: CatalogItem[]
  topArtists: ArtistStat[]
  activity: ActivityItem[]
  mixes: DailyMix[]
  mixesLoading: boolean
  personalized: boolean
  categories: Category[]
  onOpenCategory: (c: Category) => void
  onOpenMix: (m: DailyMix) => void
}) {
  return (
    <>
      {recent.length > 0 && (
        <section className="mb-8">
          <SectionHeader title="↺ recently played" />
          <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 snap-x">
            {recent.map((it, i) => (
              <RecentCard
                key={`${it.video_id}/${it.codec}/${it.bitrate}`}
                item={it}
                queue={recent}
                index={i}
              />
            ))}
          </div>
        </section>
      )}

      {topTracks.length > 0 && (
        <section className="mb-8">
          <SectionHeader title="★ your top" note="last 30 days" />
          {topArtists.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {topArtists.map((a) => (
                <span
                  key={a.artist}
                  className="font-pixel text-xs uppercase tracking-widest px-2 py-1 border border-cool/50 text-cool rounded-xs"
                >
                  {a.artist} <span className="text-ink-lo tabular-nums">·{a.play_count}</span>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 snap-x">
            {topTracks.map((it, i) => (
              <RecentCard
                key={`${it.video_id}/${it.codec}/${it.bitrate}`}
                item={it}
                queue={topTracks}
                index={i}
              />
            ))}
          </div>
        </section>
      )}

      {(mixesLoading || mixes.length > 0) && (
        <section className="mb-8">
          <SectionHeader
            title="◈ daily mixes"
            note={personalized ? 'tuned to what you play' : 'fresh every day'}
          />
          <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 snap-x">
            {mixesLoading && mixes.length === 0
              ? Array.from({ length: 3 }).map((_, i) => (
                  <div
                    key={i}
                    className="w-40 sm:w-44 flex-shrink-0 card-vapor rounded-sm overflow-hidden border border-border animate-pulse"
                  >
                    <div className="aspect-square bg-violet/10" />
                    <div className="p-2 space-y-2">
                      <div className="h-3 bg-violet/10 rounded-xs" />
                      <div className="h-3 w-1/2 bg-violet/10 rounded-xs" />
                    </div>
                  </div>
                ))
              : mixes.map((m) => (
                  <DailyMixCard key={m.id} mix={m} onOpen={() => onOpenMix(m)} />
                ))}
          </div>
        </section>
      )}

      {categories.length > 0 && (
        <section className="mb-8">
          <SectionHeader title="▦ browse" />
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {categories.map((c) => (
              <CategoryCard key={c.slug} category={c} onClick={() => onOpenCategory(c)} />
            ))}
          </div>
        </section>
      )}

      {activity.length > 0 && (
        <section className="mb-8">
          <SectionHeader title="⊹ recent activity" note="what the crew added" />
          <ul className="card-vapor rounded-sm divide-y divide-border">
            {activity.map((it, i) => (
              <ActivityRow
                key={`${it.video_id}/${it.added_at}/${i}`}
                item={it}
                queue={activity}
                index={i}
              />
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

/** One row in the activity feed: who added what. Click plays the feed from
 * here. */
function ActivityRow({
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
      onClick={() => player.play(queue.map(toLib), index)}
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

/** Square cover card for the recently-played strip; click plays from here. */
function RecentCard({
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
function DailyMixCard({ mix, onOpen }: { mix: DailyMix; onOpen: () => void }) {
  const player = useAudioPlayer()
  const a = ACCENT[mix.accent]
  const cover = mix.tracks[0]?.thumbnail_url ?? null
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
        {cover && (
          <img
            src={cover}
            alt=""
            className="w-full h-full object-cover opacity-60"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        )}
        <span
          className={`absolute top-2 left-2 font-pixel text-xs uppercase tracking-widest ${a.text}`}
          style={{ textShadow: '0 0 8px currentColor' }}
        >
          {mix.title}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            player.play(mix.tracks.map(toLibraryItem), 0)
          }}
          title="play this mix"
          aria-label="play this mix"
          className="absolute bottom-2 right-2 w-9 h-9 flex items-center justify-center rounded-full bg-hot/80 text-ink-hi shadow-[var(--shadow-glow-hot)] opacity-0 group-hover:opacity-100 transition hover:bg-hot"
        >
          ▶
        </button>
      </div>
      <div className="p-2">
        <div className="font-sans text-xs font-medium text-ink-hi truncate">
          {mix.subtitle}
        </div>
        <div className="text-xs text-ink-lo tabular-nums">{mix.tracks.length} tracks</div>
      </div>
    </div>
  )
}

/** Browse grid tile for a curated category — gradient + title, no emoji
 * (keeps the pixel/vaporwave aesthetic clean). */
function CategoryCard({
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

/** Expanded category feed: playable catalog tracks + downloadable candidates. */
function CategoryView({
  category,
  feed,
  isLoading,
  onBack,
}: {
  category: Category
  feed: { db: CatalogItem[]; external: ExternalCatalogItem[] } | undefined
  isLoading: boolean
  onBack: () => void
}) {
  const player = useAudioPlayer()
  const db = feed?.db ?? []
  const external = feed?.external ?? []
  return (
    <section>
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <button
          type="button"
          onClick={onBack}
          className="font-pixel text-xs uppercase tracking-widest px-2 py-1 border border-border text-ink-lo hover:text-cool hover:border-cool/70 transition rounded-xs"
        >
          ← back
        </button>
        <h2 className={`font-pixel text-lg uppercase tracking-widest ${ACCENT[category.accent].text}`}>
          {category.title}
        </h2>
        {db.length > 0 && (
          <button
            type="button"
            onClick={() => player.play(db.map(toLibraryItem), 0)}
            className="font-pixel text-xs uppercase tracking-widest px-3 py-1 border border-hot bg-hot/15 text-ink-hi shadow-[var(--shadow-glow-hot)] hover:bg-hot/25 transition rounded-xs"
          >
            ▶ play all
          </button>
        )}
      </div>

      {isLoading && (
        <div className="font-pixel text-ink-mid">
          ··· loading {category.title.toLowerCase()} ···
        </div>
      )}

      {db.length > 0 && (
        <ul className="card-vapor rounded-sm divide-y divide-border mb-2">
          {db.map((it, idx) => (
            <CatalogRow
              key={`${it.video_id}/${it.codec}/${it.bitrate}`}
              item={it}
              position={idx + 1}
              allItems={db}
            />
          ))}
        </ul>
      )}

      {external.length > 0 && (
        <>
          <div className="mt-6 mb-3 flex items-center gap-3 font-pixel text-xs text-ink-lo uppercase tracking-[0.2em]">
            <span>↓ download more {category.title.toLowerCase()}</span>
            <span className="flex-1 border-t border-border" />
            <DownloadAllButton items={external} />
          </div>
          <ul className="card-vapor rounded-sm divide-y divide-border">
            {external.map((ext, idx) => (
              <ExternalRow
                key={ext.video_id}
                item={ext}
                position={db.length + idx + 1}
              />
            ))}
          </ul>
        </>
      )}

      {!isLoading && db.length === 0 && external.length === 0 && (
        <div className="card-vapor rounded-sm p-8 text-center font-pixel text-ink-lo">
          nothing found for this category right now.
        </div>
      )}
    </section>
  )
}

/** Daily-mix preview: the full tracklist with play-all, opened from a mix card. */
function MixView({ mix, onBack }: { mix: DailyMix; onBack: () => void }) {
  const player = useAudioPlayer()
  const a = ACCENT[mix.accent]
  const cover = mix.tracks[0]?.thumbnail_url ?? null
  return (
    <section>
      <div className="flex items-center gap-4 mb-5 flex-wrap">
        <button
          type="button"
          onClick={onBack}
          className="font-pixel text-xs uppercase tracking-widest px-2 py-1 border border-border text-ink-lo hover:text-cool hover:border-cool/70 transition rounded-xs"
        >
          ← back
        </button>
        <div
          className={`relative w-16 h-16 rounded-sm overflow-hidden border ${a.border} bg-gradient-to-br ${a.grad} flex-shrink-0`}
        >
          {cover && (
            <img
              src={cover}
              alt=""
              className="w-full h-full object-cover opacity-60"
              referrerPolicy="no-referrer"
            />
          )}
        </div>
        <div className="min-w-0">
          <div className={`font-pixel text-lg uppercase tracking-widest ${a.text}`}>
            {mix.title}
          </div>
          <div className="font-sans text-sm text-ink-mid truncate">
            {mix.subtitle} · {mix.tracks.length} tracks
          </div>
        </div>
        {mix.tracks.length > 0 && (
          <button
            type="button"
            onClick={() => player.play(mix.tracks.map(toLibraryItem), 0)}
            className="font-pixel text-xs uppercase tracking-widest px-4 py-2 border border-hot bg-hot/15 text-ink-hi shadow-[var(--shadow-glow-hot)] hover:bg-hot/25 transition rounded-xs"
          >
            ▶ play all
          </button>
        )}
      </div>

      <ul className="card-vapor rounded-sm divide-y divide-border">
        {mix.tracks.map((it, idx) => (
          <CatalogRow
            key={`${it.video_id}/${it.codec}/${it.bitrate}`}
            item={it}
            position={idx + 1}
            allItems={mix.tracks}
          />
        ))}
      </ul>

      {mix.external.length > 0 && (
        <>
          <div className="mt-6 mb-3 flex items-center gap-3 font-pixel text-xs text-ink-lo uppercase tracking-[0.2em]">
            <span>↓ more in this mix · download to play</span>
            <span className="flex-1 border-t border-border" />
            <DownloadAllButton items={mix.external} own={false} />
          </div>
          <ul className="card-vapor rounded-sm divide-y divide-border">
            {mix.external.map((ext, idx) => (
              <ExternalRow
                key={ext.video_id}
                item={ext}
                position={mix.tracks.length + idx + 1}
                own={false}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

/** "More like this" radio from a seed track: what you already have (playable)
 * + new candidates to download. */
function RadioView({
  seed,
  feed,
  isLoading,
  onBack,
}: {
  seed: CatalogItem
  feed: { db: CatalogItem[]; external: ExternalCatalogItem[] } | undefined
  isLoading: boolean
  onBack: () => void
}) {
  const player = useAudioPlayer()
  const db = feed?.db ?? []
  const external = feed?.external ?? []
  return (
    <section>
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <button
          type="button"
          onClick={onBack}
          className="font-pixel text-xs uppercase tracking-widest px-2 py-1 border border-border text-ink-lo hover:text-cool hover:border-cool/70 transition rounded-xs"
        >
          ← back
        </button>
        <div className="relative w-14 h-14 rounded-sm overflow-hidden border border-cool/50 bg-page-mid flex-shrink-0">
          {seed.thumbnail_url ? (
            <img
              src={seed.thumbnail_url}
              alt=""
              className="w-full h-full object-cover"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-violet/40 via-hot/20 to-cool/30" />
          )}
        </div>
        <div className="min-w-0">
          <div className="font-pixel text-lg uppercase tracking-widest text-cool">
            ≈ radio
          </div>
          <div className="font-sans text-sm text-ink-mid truncate">
            like {seed.title ?? seed.video_id}
          </div>
        </div>
        {db.length > 0 && (
          <button
            type="button"
            onClick={() => player.play(db.map(toLibraryItem), 0)}
            className="font-pixel text-xs uppercase tracking-widest px-4 py-2 border border-hot bg-hot/15 text-ink-hi shadow-[var(--shadow-glow-hot)] hover:bg-hot/25 transition rounded-xs"
          >
            ▶ play all
          </button>
        )}
      </div>

      {isLoading && (
        <div className="font-pixel text-ink-mid">··· tuning the radio ···</div>
      )}

      {db.length > 0 && (
        <ul className="card-vapor rounded-sm divide-y divide-border mb-2">
          {db.map((it, idx) => (
            <CatalogRow
              key={`${it.video_id}/${it.codec}/${it.bitrate}`}
              item={it}
              position={idx + 1}
              allItems={db}
            />
          ))}
        </ul>
      )}

      {external.length > 0 && (
        <>
          <div className="mt-6 mb-3 flex items-center gap-3 font-pixel text-xs text-ink-lo uppercase tracking-[0.2em]">
            <span>↓ download more like this</span>
            <span className="flex-1 border-t border-border" />
            <DownloadAllButton items={external} />
          </div>
          <ul className="card-vapor rounded-sm divide-y divide-border">
            {external.map((ext, idx) => (
              <ExternalRow
                key={ext.video_id}
                item={ext}
                position={db.length + idx + 1}
              />
            ))}
          </ul>
        </>
      )}

      {!isLoading && db.length === 0 && external.length === 0 && (
        <div className="card-vapor rounded-sm p-8 text-center font-pixel text-ink-lo">
          couldn't tune a radio for this track right now.
        </div>
      )}
    </section>
  )
}

export function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
