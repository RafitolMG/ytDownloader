import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { AppHeader } from '@/shared/ui/AppHeader'
import { api } from '@/shared/api/client'
import type {
  CatalogItem,
  CatalogSort,
  Category,
  DailyMix,
  ExternalCatalogItem,
} from '@/shared/api/types'
import { countActive, useJobs } from '@/shared/api/useJobs'
import { useDebouncedValue } from '@/shared/lib/useDebouncedValue'
import { catalogToLibrary as toLibraryItem } from '@/shared/lib/libraryItem'
import { SectionHeader } from '@/shared/ui/SectionHeader'
import { useAudioPlayer } from '@/features/player/AudioPlayerProvider'
import { RadioCtx } from '@/features/catalog/RadioContext'
import { CatalogRow, ExternalRow } from '@/features/catalog/rows'
import { SuggestionCard, SuggestionSkeleton } from '@/features/catalog/cards'
import { BrowseHome } from '@/features/catalog/BrowseHome'
import { CategoryView, MixView, RadioView } from '@/features/catalog/views'

const SORT_LABELS: Record<CatalogSort, string> = {
  newest: 'newest',
  popular: '♥ most saved',
  title: 'title a→z',
  artist: 'artist a→z',
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
            aria-label="search the catalog and youtube"
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
