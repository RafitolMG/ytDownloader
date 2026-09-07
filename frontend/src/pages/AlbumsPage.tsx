import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import { AppHeader } from '@/shared/ui/AppHeader'
import { useBackClose } from '@/shared/lib/backStack'
import { EmptyState } from '@/shared/ui/EmptyState'
import { ApiError, api } from '@/shared/api/client'
import { useMutationErrorToast } from '@/shared/lib/mutationError'
import type {
  AlbumCard,
  CatalogItem,
  ExternalCatalogItem,
  LibraryItem,
} from '@/shared/api/types'
import { countActive, useJobs } from '@/shared/api/useJobs'
import { fmtDuration } from '@/shared/lib/format'
import { useDebouncedValue } from '@/shared/lib/useDebouncedValue'
import {
  catalogToLibrary as toLibraryItem,
  catalogToPlaylistRow,
  libraryToPlaylistRow,
} from '@/shared/lib/libraryItem'
import { SectionHeader } from '@/shared/ui/SectionHeader'
import { useAudioPlayer } from '@/features/player/AudioPlayerProvider'
import { CatalogRow, DownloadAllButton, ExternalRow } from '@/features/catalog/rows'
import { OfflineDownloadButton } from '@/features/offline/OfflineDownloadButton'
import { OfflineFallback } from '@/features/offline/OfflineFallback'

/** Comparison key for a track title: accents dropped, bracketed asides removed,
 *  punctuation flattened, non-Latin scripts kept. Mirrors
 *  `search.normalize_title` on the backend, which uses the same key to pick the
 *  right edition in the first place — they have to agree exactly. */
function normalizeTitle(title: string | null | undefined): string {
  return (title ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
}

/** A library album: the user's owned tracks grouped under one album title. */
type LibraryAlbum = {
  key: string
  title: string
  artist: string | null
  cover: string | null
  year: number | null
  tracks: LibraryItem[]
}

/** Group the caller's library into albums. Tracks with no album are singles and
 * are left out (they live in the catalog/liked views, not here). */
function groupLibraryAlbums(items: LibraryItem[]): LibraryAlbum[] {
  const byAlbum = new Map<string, LibraryAlbum>()
  for (const it of items) {
    const album = (it.album ?? '').trim()
    if (!album) continue
    const key = album.toLowerCase()
    let group = byAlbum.get(key)
    if (!group) {
      group = {
        key,
        title: album,
        artist: it.album_artist ?? it.artist ?? null,
        cover: it.thumbnail_url ?? null,
        year: it.release_year ?? null,
        tracks: [],
      }
      byAlbum.set(key, group)
    }
    if (!group.cover && it.thumbnail_url) group.cover = it.thumbnail_url
    if (!group.year && it.release_year) group.year = it.release_year
    group.tracks.push(it)
  }
  // Albums with the most tracks first — the fullest collections lead.
  return [...byAlbum.values()].sort((a, b) => b.tracks.length - a.tracks.length)
}

/** Does a library album match the search box? Title or artist substring. */
function albumMatches(a: LibraryAlbum, query: string): boolean {
  const needle = query.toLowerCase()
  return (
    a.title.toLowerCase().includes(needle) ||
    (a.artist ?? '').toLowerCase().includes(needle)
  )
}

type OpenAlbum =
  | { kind: 'remote'; card: AlbumCard }
  | { kind: 'library'; album: LibraryAlbum }

export default function AlbumsPage() {
  const jobsQuery = useJobs()
  const activeCount = countActive(jobsQuery.data)

  const [query, setQuery] = useState('')
  const trimmed = query.trim()
  const debouncedQuery = useDebouncedValue(trimmed, 500)
  const isSearching = debouncedQuery.length >= 2

  const [open, setOpen] = useState<OpenAlbum | null>(null)
  // Album detail is local state, not a route — let the back gesture close it
  // first instead of navigating away from the Albums page.
  const closeAlbum = useCallback(() => setOpen(null), [])
  useBackClose(open !== null, closeAlbum)

  const libraryQuery = useQuery({
    queryKey: ['library'],
    queryFn: () => api.library(),
    staleTime: 10_000,
  })
  const libraryAlbums = useMemo(
    () => groupLibraryAlbums(libraryQuery.data?.items ?? []),
    [libraryQuery.data],
  )

  const searchQuery = useQuery({
    queryKey: ['album-search', debouncedQuery],
    queryFn: () => api.albumSearch(debouncedQuery, 12),
    enabled: isSearching,
    staleTime: 5 * 60_000,
  })
  const searchAlbums = isSearching ? searchQuery.data?.albums ?? [] : []

  // The search box searches your own albums too — not just YouTube Music — so an
  // album you already have surfaces first instead of being hidden behind remote
  // results.
  const matchedLibraryAlbums = useMemo(
    () =>
      isSearching
        ? libraryAlbums.filter((a) => albumMatches(a, debouncedQuery))
        : [],
    [isSearching, libraryAlbums, debouncedQuery],
  )

  if (open) {
    return (
      <Shell queueCount={activeCount}>
        {open.kind === 'remote' ? (
          <RemoteAlbumView card={open.card} onBack={() => setOpen(null)} />
        ) : (
          <LibraryAlbumView album={open.album} onBack={() => setOpen(null)} />
        )}
      </Shell>
    )
  }

  return (
    <Shell queueCount={activeCount}>
      <div className="font-pixel text-xs text-ink-lo uppercase tracking-[0.2em] mb-4">
        ░▒▓ albums ▓▒░
      </div>

      <div className="card-vapor rounded-sm p-3 mb-6 flex items-center gap-3 font-pixel">
        <span className="text-cool text-xl">⌕</span>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search albums on youtube music..."
          aria-label="search albums on youtube music"
          spellCheck={false}
          autoComplete="off"
          className="flex-1 bg-transparent border-none outline-none text-ink-hi placeholder:text-ink-lo text-lg caret-cool"
        />
        {trimmed && (
          <button
            type="button"
            onClick={() => setQuery('')}
            className="text-sm uppercase tracking-widest px-2 py-1 border border-ink-lo/50 text-ink-lo hover:text-crit hover:border-crit/60 transition rounded-xs"
            aria-label="clear search"
            title="clear search"
          >
            ✕
          </button>
        )}
      </div>

      {isSearching ? (
        <>
          {matchedLibraryAlbums.length > 0 && (
            <section className="mb-8">
              <SectionHeader title="▤ your albums" note="in your library" />
              <AlbumGrid>
                {matchedLibraryAlbums.map((a) => (
                  <LibraryAlbumCard
                    key={a.key}
                    album={a}
                    onOpen={() => setOpen({ kind: 'library', album: a })}
                  />
                ))}
              </AlbumGrid>
            </section>
          )}

          <section>
            <SectionHeader title="◉ album results" note="youtube music" />
            {searchQuery.isLoading && (
              <div className="font-pixel text-ink-mid">··· searching albums ···</div>
            )}
            {searchQuery.isError && (
              <div className="font-pixel text-crit">
                album search failed —{' '}
                {searchQuery.error instanceof Error
                  ? searchQuery.error.message
                  : 'unknown'}
              </div>
            )}
            {searchQuery.data && searchAlbums.length === 0 && (
              <div className="card-vapor rounded-sm p-8 text-center font-pixel text-ink-lo">
                no albums found for "{debouncedQuery}"
                {matchedLibraryAlbums.length > 0 ? ' on youtube music.' : '.'}
              </div>
            )}
            <AlbumGrid>
              {searchAlbums.map((a) => (
                <RemoteAlbumCard
                  key={a.album_id}
                  album={a}
                  onOpen={() => setOpen({ kind: 'remote', card: a })}
                />
              ))}
            </AlbumGrid>
          </section>
        </>
      ) : (
        <section>
          <SectionHeader title="▤ your albums" note="grouped from your library" />
          {libraryQuery.isLoading && (
            <div className="font-pixel text-ink-mid">··· loading your albums ···</div>
          )}
          {/* Distinct from the empty state below: a failed fetch is not an
              empty library, and telling the user it is loses their albums. */}
          {libraryQuery.isError && (
            <div className="card-vapor rounded-sm p-8 text-center font-pixel">
              <div className="text-crit mb-3">
                couldn't load your albums —{' '}
                {libraryQuery.error instanceof Error
                  ? libraryQuery.error.message
                  : 'unknown'}
              </div>
              <button
                type="button"
                onClick={() => libraryQuery.refetch()}
                className="uppercase tracking-widest text-xs px-3 py-1.5 border border-cool/60 text-cool hover:bg-cool/10 transition rounded-xs"
              >
                ↻ retry
              </button>
            </div>
          )}
          {libraryQuery.isError && <OfflineFallback />}
          {!libraryQuery.isLoading &&
            !libraryQuery.isError &&
            libraryAlbums.length === 0 && (
              <EmptyState
                glyph="◉"
                title="no albums yet"
                hint="search an album above and download it — its tracks group here automatically."
              />
            )}
          <AlbumGrid>
            {libraryAlbums.map((a) => (
              <LibraryAlbumCard
                key={a.key}
                album={a}
                onOpen={() => setOpen({ kind: 'library', album: a })}
              />
            ))}
          </AlbumGrid>
        </section>
      )}
    </Shell>
  )
}

function Shell({
  queueCount,
  children,
}: {
  queueCount: number
  children: React.ReactNode
}) {
  return (
    <div className="relative z-10 min-h-full">
      <main className="max-w-6xl mx-auto px-3 sm:px-6 py-4 sm:py-8 pb-bottombars">
        <AppHeader queueCount={queueCount} />
        {children}
      </main>
    </div>
  )
}

function AlbumGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
      {children}
    </div>
  )
}

/** Square album cover card. Shared layout for both library and remote albums. */
function AlbumCover({
  cover,
  title,
  subtitle,
  badge,
  onOpen,
  onPlay,
}: {
  cover: string | null
  title: string
  subtitle: string | null
  badge: string
  onOpen: () => void
  onPlay?: () => void
}) {
  return (
    <div
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onOpen()
      }}
      className="group text-left cursor-pointer card-vapor rounded-sm overflow-hidden border border-border hover:border-cool/60 transition"
      title={`${title}${subtitle ? ` — ${subtitle}` : ''}`}
    >
      <div className="relative aspect-square bg-page-mid">
        {cover ? (
          <img
            src={cover}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-violet/40 via-hot/20 to-cool/30" />
        )}
        <span className="absolute top-1.5 left-1.5 font-pixel text-[10px] uppercase tracking-widest bg-page/80 text-cool px-1.5 py-0.5 rounded-xs">
          {badge}
        </span>
        {onPlay && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onPlay()
            }}
            title="play album"
            aria-label="play album"
            className="absolute bottom-2 right-2 w-9 h-9 flex items-center justify-center rounded-full bg-hot/80 text-ink-hi shadow-[var(--shadow-glow-hot)] opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition hover:bg-hot"
          >
            ▶
          </button>
        )}
      </div>
      <div className="p-2">
        <div className="font-sans text-sm font-medium text-ink-hi line-clamp-2 leading-snug min-h-[2.5rem]">
          {title}
        </div>
        <div className="text-xs text-ink-lo truncate mt-0.5">{subtitle ?? '—'}</div>
      </div>
    </div>
  )
}

function LibraryAlbumCard({
  album,
  onOpen,
}: {
  album: LibraryAlbum
  onOpen: () => void
}) {
  const player = useAudioPlayer()
  return (
    <AlbumCover
      cover={album.cover}
      title={album.title}
      subtitle={album.artist}
      badge={`${album.tracks.length} ♪`}
      onOpen={onOpen}
      onPlay={() => player.play(album.tracks, 0)}
    />
  )
}

function RemoteAlbumCard({
  album,
  onOpen,
}: {
  album: AlbumCard
  onOpen: () => void
}) {
  return (
    <AlbumCover
      cover={album.thumbnail}
      title={album.title ?? album.album_id}
      subtitle={album.artist}
      badge={`${album.track_count} ♪`}
      onOpen={onOpen}
    />
  )
}

/** A library album opened up. A library album is only the tracks the user owns
 * grouped by title, so on open we re-resolve it against YouTube Music to show
 * the *full* tracklist — owned tracks stay playable, the ones not yet in the DB
 * become downloadable rows. If the resolved album doesn't convincingly contain
 * the tracks we own, we fall back to the owned-only list (correct, just without
 * the "missing" rows) rather than risk showing a wrong album. */
function LibraryAlbumView({
  album,
  onBack,
}: {
  album: LibraryAlbum
  onBack: () => void
}) {
  const player = useAudioPlayer()

  const resolved = useQuery({
    queryKey: ['album-resolve', album.key],
    queryFn: () => api.albumResolve(album.title, album.artist),
    staleTime: 30 * 60_000,
    // A 404 is an answer; a 5xx is youtube music being flaky, which is the
    // documented failure mode of the box this runs on. Retry only the latter.
    retry: (count, e) =>
      count < 2 && e instanceof ApiError && e.status >= 500,
  })

  const remoteTracks = resolved.data?.tracks ?? []
  const dbItems = resolved.data?.db ?? []
  const dbById = useMemo(() => {
    const m = new Map<string, CatalogItem>()
    for (const it of dbItems) m.set(it.video_id, it)
    return m
  }, [dbItems])

  // A track taken from plain YouTube has a different video id than its YouTube
  // Music twin, so comparing ids alone can never recognise it on the album's
  // tracklist — no threshold fixes that. Fall back to the normalized title.
  const ownedByTitle = useMemo(() => {
    const m = new Map<string, LibraryItem>()
    for (const t of album.tracks) {
      const key = normalizeTitle(t.title)
      if (key && !m.has(key)) m.set(key, t)
    }
    return m
  }, [album.tracks])

  /** The track we already own that this album entry refers to, if any. */
  const ownedMatch = (t: ExternalCatalogItem): LibraryItem | undefined =>
    album.tracks.find((o) => o.video_id === t.video_id) ??
    ownedByTitle.get(normalizeTitle(t.title))
  // One owned track on the resolved list is the signal that matters: the search
  // is *steered* by the ids we own, so an edition containing any of them is the
  // one we downloaded from — while zero overlap means a bare title search picked
  // something (a karaoke or tribute pressing) we shouldn't trust.
  //
  // Requiring more was the bug. A majority reads as looser than "all", but for
  // the common 2-track group it demands both, exactly like the rule it replaced.
  // Nothing is lost by relaxing it: owned tracks the edition doesn't list render
  // under it, which is what the old all-or-nothing gate existed to guarantee.
  const matchedOwned = remoteTracks.filter((t) => ownedMatch(t) !== undefined).length
  const confident = remoteTracks.length > 0 && matchedOwned >= 1

  const resolveError = resolved.error
  // Name what actually happened. "couldn't match" on its own can't tell apart
  // "the search surfaced a different record" from "the right record titles its
  // tracks differently", and those need opposite fixes — so say which album came
  // back and let the mismatch be visible.
  const foundTitle = resolved.data?.album?.title
  const resolveProblem = !resolved.isError
    ? foundTitle
      ? `found "${foundTitle}" on youtube music, but none of your tracks are on it`
      : "couldn't match this album on youtube music"
    : resolveError instanceof ApiError && resolveError.status >= 500
      ? 'youtube music is unreachable right now'
      : resolveError instanceof ApiError && resolveError.status === 404
        ? "this album isn't on youtube music"
        : "couldn't reach youtube music"

  // Owned tracks the resolved edition doesn't list at all — by id or by title.
  const matchedOwnedKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const t of remoteTracks) {
      const owned = ownedMatch(t)
      if (owned) keys.add(`${owned.video_id}/${owned.codec}/${owned.bitrate}`)
    }
    return keys
  }, [remoteTracks, ownedByTitle, album.tracks])
  const strayOwned = confident
    ? album.tracks.filter(
        (t) => !matchedOwnedKeys.has(`${t.video_id}/${t.codec}/${t.bitrate}`),
      )
    : []

  // The album's tracks not yet in the catalog — the "download missing" targets.
  // A track we already own under another id is not missing; offering it would
  // just add a duplicate.
  const missingItems = confident
    ? remoteTracks.filter((t) => !dbById.has(t.video_id) && !ownedMatch(t))
    : []
  const missingCount = missingItems.length

  // Owned tracks as offline-download rows. Only tracks in the DB can be streamed
  // (and therefore downloaded) offline, which is exactly the ones we own here.
  const offlineTracks = useMemo(
    () => album.tracks.map((t, i) => libraryToPlaylistRow(t, i)),
    [album.tracks],
  )

  const playAlbum = () =>
    confident && dbItems.length > 0
      ? player.play([...dbItems.map(toLibraryItem), ...strayOwned], 0)
      : player.play(album.tracks, 0)

  return (
    <section>
      <AlbumHeader
        cover={album.cover}
        title={album.title}
        artist={album.artist}
        meta={[
          confident
            ? `${matchedOwned} of ${remoteTracks.length} tracks`
            : `${album.tracks.length} tracks`,
          album.year ? String(album.year) : null,
          missingCount > 0 ? `${missingCount} missing` : null,
        ]}
        onBack={onBack}
        actions={
          <>
            <button
              type="button"
              onClick={playAlbum}
              className="font-pixel text-xs uppercase tracking-widest px-4 py-2 border border-hot bg-hot/15 text-ink-hi shadow-[var(--shadow-glow-hot)] hover:bg-hot/25 transition rounded-xs"
            >
              ▶ play album
            </button>
            {missingCount > 0 && (
              <DownloadAllButton
                items={missingItems}
                label="download missing"
                title="download the album's missing tracks to the catalog (mp3 · 320)"
              />
            )}
            <OfflineDownloadButton
              id={`album:${album.key}`}
              name={album.title}
              tracks={offlineTracks}
            />
          </>
        }
      />

      {resolved.isFetching && (
        <div className="font-pixel text-ink-mid mb-3">
          ··· finding missing tracks ···
        </div>
      )}

      {/* Say it out loud: without this the owned tracks read as the full album.
          And say *which* thing failed — an outage is not a failed match, and
          telling the user the album couldn't be matched when youtube music is
          simply down sends them looking for the wrong problem. */}
      {!resolved.isFetching && !confident && (
        <div className="font-pixel text-xs text-ink-lo mb-3 flex items-center gap-2 flex-wrap">
          <span>
            {resolveProblem} — showing the {album.tracks.length} track
            {album.tracks.length === 1 ? '' : 's'} you own, so some may be
            missing.
          </span>
          <button
            type="button"
            onClick={() => resolved.refetch()}
            className="uppercase tracking-widest px-2 py-1 border border-cool/60 text-cool hover:bg-cool/10 transition rounded-xs"
          >
            ↻ retry
          </button>
        </div>
      )}

      {confident ? (
        <>
          <ul className="card-vapor rounded-sm divide-y divide-border">
            {remoteTracks.map((t, idx) => {
              const hit = dbById.get(t.video_id)
              if (hit) {
                return (
                  <CatalogRow
                    key={t.video_id}
                    item={hit}
                    position={idx + 1}
                    allItems={dbItems}
                  />
                )
              }
              // Same song, different video id — play the copy we have instead
              // of offering to download it again.
              const owned = ownedMatch(t)
              if (owned) {
                return (
                  <OwnedTrackRow
                    key={t.video_id}
                    track={owned}
                    position={idx + 1}
                    onPlay={() =>
                      player.play(album.tracks, album.tracks.indexOf(owned))
                    }
                  />
                )
              }
              return <ExternalRow key={t.video_id} item={t} position={idx + 1} />
            })}
          </ul>
          {strayOwned.length > 0 && (
            <div className="mt-5">
              <SectionHeader title="▤ also in your library" note="not on this edition" />
              <OwnedTrackList tracks={strayOwned} />
            </div>
          )}
        </>
      ) : (
        <OwnedTrackList tracks={album.tracks} />
      )}
    </section>
  )
}

/** A plain list of owned tracks — the whole library album while it resolves (or
 * when it can't be matched), and the owned tracks the resolved edition doesn't
 * list. */
function OwnedTrackRow({
  track,
  position,
  onPlay,
}: {
  track: LibraryItem
  position: number
  onPlay: () => void
}) {
  const player = useAudioPlayer()
  const isCurrent =
    player.current?.video_id === track.video_id &&
    player.current?.codec === track.codec &&
    player.current?.bitrate === track.bitrate

  return (
    <li
      role="button"
      tabIndex={0}
      aria-label={`play ${track.title ?? track.video_id}`}
      onClick={onPlay}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onPlay()
        }
      }}
      className={`flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2 cursor-pointer transition ${
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
      <div className="flex-1 min-w-0">
        <div className="font-sans text-sm font-medium text-ink-hi leading-snug truncate">
          {track.title ?? track.video_id}
        </div>
        <div className="text-sm text-ink-lo truncate mt-0.5">
          {track.artist ?? '—'}
        </div>
      </div>
      {track.duration_sec != null && (
        <div className="font-pixel text-xs text-ink-lo tabular-nums">
          {fmtDuration(track.duration_sec)}
        </div>
      )}
    </li>
  )
}

function OwnedTrackList({ tracks }: { tracks: LibraryItem[] }) {
  const player = useAudioPlayer()
  return (
    <ul className="card-vapor rounded-sm divide-y divide-border">
      {tracks.map((t, idx) => (
        <OwnedTrackRow
          key={`${t.video_id}/${t.codec}/${t.bitrate}`}
          track={t}
          position={idx + 1}
          onPlay={() => player.play(tracks, idx)}
        />
      ))}
    </ul>
  )
}

/** A remote (YouTube Music) album opened up: header + download-album + the full
 * tracklist in album order — playable rows for tracks already in the catalog,
 * downloadable rows for the rest. */
function RemoteAlbumView({
  card,
  onBack,
}: {
  card: AlbumCard
  onBack: () => void
}) {
  const player = useAudioPlayer()
  const detail = useQuery({
    queryKey: ['album', card.album_id],
    queryFn: () => api.album(card.album_id),
    staleTime: 5 * 60_000,
  })

  const dbItems = detail.data?.db ?? []
  const tracks = detail.data?.tracks ?? []
  const dbById = useMemo(() => {
    const m = new Map<string, CatalogItem>()
    for (const it of dbItems) m.set(it.video_id, it)
    return m
  }, [dbItems])
  // The album's DB tracks as offline-download rows (only these can stream offline).
  const offlineTracks = useMemo(
    () => dbItems.map((c, i) => catalogToPlaylistRow(c, i)),
    [dbItems],
  )

  return (
    <section>
      <AlbumHeader
        cover={card.thumbnail}
        title={card.title ?? card.album_id}
        artist={card.artist}
        meta={[`${card.track_count} tracks`, detail.data?.album.artist ?? null]}
        onBack={onBack}
        actions={
          <>
            {dbItems.length > 0 && (
              <button
                type="button"
                onClick={() => player.play(dbItems.map(toLibraryItem), 0)}
                className="font-pixel text-xs uppercase tracking-widest px-4 py-2 border border-hot bg-hot/15 text-ink-hi shadow-[var(--shadow-glow-hot)] hover:bg-hot/25 transition rounded-xs"
              >
                ▶ play
              </button>
            )}
            <AlbumDownloadButton url={card.url} />
            <OfflineDownloadButton
              id={`album:${card.album_id}`}
              name={card.title ?? card.album_id}
              tracks={offlineTracks}
            />
          </>
        }
      />

      {detail.isFetching && (
        <div className="font-pixel text-ink-mid">··· loading album ···</div>
      )}
      {detail.isError && (
        <div className="font-pixel text-crit">
          couldn't load this album —{' '}
          {detail.error instanceof Error ? detail.error.message : 'unknown'}
        </div>
      )}

      {!detail.isFetching && !detail.isError && tracks.length === 0 && (
        <div className="card-vapor rounded-sm p-8 text-center font-pixel text-ink-lo">
          this album came back without a tracklist.
          <button
            type="button"
            onClick={() => detail.refetch()}
            className="ml-3 uppercase tracking-widest text-xs px-2 py-1 border border-cool/60 text-cool hover:bg-cool/10 transition rounded-xs"
          >
            ↻ retry
          </button>
        </div>
      )}

      {tracks.length > 0 && (
        <ul className="card-vapor rounded-sm divide-y divide-border">
          {tracks.map((t, idx) => {
            const hit = dbById.get(t.video_id)
            return hit ? (
              <CatalogRow
                key={t.video_id}
                item={hit}
                position={idx + 1}
                allItems={dbItems}
              />
            ) : (
              <ExternalRow key={t.video_id} item={t} position={idx + 1} />
            )
          })}
        </ul>
      )}
    </section>
  )
}

function AlbumHeader({
  cover,
  title,
  artist,
  meta,
  onBack,
  actions,
}: {
  cover: string | null
  title: string
  artist: string | null
  meta: (string | null)[]
  onBack: () => void
  actions?: React.ReactNode
}) {
  const metaLine = meta.filter(Boolean).join(' · ')
  return (
    <div className="flex items-center gap-4 mb-5 flex-wrap">
      <button
        type="button"
        onClick={onBack}
        className="font-pixel text-xs uppercase tracking-widest px-2 py-1 border border-border text-ink-lo hover:text-cool hover:border-cool/70 transition rounded-xs"
      >
        ← back
      </button>
      <div className="relative w-20 h-20 sm:w-24 sm:h-24 rounded-sm overflow-hidden border border-cool/40 bg-page-mid flex-shrink-0">
        {cover ? (
          <img
            src={cover}
            alt=""
            className="w-full h-full object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-violet/40 via-hot/20 to-cool/30" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-pixel text-[10px] uppercase tracking-[0.2em] text-cool mb-1">
          ◉ album
        </div>
        <h2 className="font-sans text-xl font-semibold text-ink-hi leading-tight line-clamp-2">
          {title}
        </h2>
        <div className="font-sans text-sm text-ink-mid truncate mt-0.5">
          {artist ?? '—'}
          {metaLine && <span className="text-ink-lo"> · {metaLine}</span>}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap">{actions}</div>
    </div>
  )
}

/** Fire a whole-album download through the playlist flow. The album resolves to
 * a YouTube Music playlist of its tracks; each lands in the shared catalog as
 * mp3-320 and the user gets a mirrored playlist. */
function AlbumDownloadButton({ url }: { url: string }) {
  const qc = useQueryClient()
  const [done, setDone] = useState(false)

  const dl = useMutation({
    mutationFn: () => api.downloadPlaylist(url),
    onSuccess: () => {
      setDone(true)
      qc.invalidateQueries({ queryKey: ['catalog'] })
      qc.invalidateQueries({ queryKey: ['library'] })
      qc.invalidateQueries({ queryKey: ['playlists'] })
    },
    onError: useMutationErrorToast()('album download'),
  })

  return (
    <button
      type="button"
      onClick={() => {
        if (!dl.isPending && !done) dl.mutate()
      }}
      disabled={dl.isPending || done}
      title="download the whole album to the catalog (mp3 · 320)"
      className="font-pixel text-xs uppercase tracking-widest px-4 py-2 border border-cool/60 text-cool hover:bg-cool/10 hover:shadow-[var(--shadow-glow-cool)] disabled:opacity-60 transition rounded-xs whitespace-nowrap"
    >
      {dl.isPending
        ? '··· queueing'
        : done
          ? '✓ queued — see queue'
          : '⬇ download album'}
    </button>
  )
}
