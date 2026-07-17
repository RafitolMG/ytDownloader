import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useWindowVirtualizer } from '@tanstack/react-virtual'
import { Link } from 'react-router-dom'
import { AppHeader } from '@/shared/ui/AppHeader'
import { EmptyState } from '@/shared/ui/EmptyState'
import { useToast } from '@/shared/ui/ToastProvider'
import { api } from '@/shared/api/client'
import type { LibraryItem } from '@/shared/api/types'
import { countActive, useJobs } from '@/shared/api/useJobs'
import { useAudioPlayer } from '@/features/player/AudioPlayerProvider'
import { AddToPlaylistMenu } from '@/features/playlists/AddToPlaylistMenu'
import { NowPlayingTick } from '@/shared/ui/NowPlayingTick'

type LikedSort = 'recent' | 'title' | 'artist'
const SORTS: { id: LikedSort; label: string }[] = [
  { id: 'recent', label: 'recent' },
  { id: 'title', label: 'title a→z' },
  { id: 'artist', label: 'artist a→z' },
]

/** "Liked Songs" — the user's saved/owned tracks, surfaced as a pinned playlist
 * in the Playlists section (Spotify-style) rather than in the catalog. */
export default function LikedSongsPage() {
  const jobsQuery = useJobs()
  const activeCount = countActive(jobsQuery.data)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<LikedSort>(() => {
    const s = localStorage.getItem('ytdl.liked.sort')
    return s === 'title' || s === 'artist' || s === 'recent' ? s : 'recent'
  })
  useEffect(() => {
    localStorage.setItem('ytdl.liked.sort', sort)
  }, [sort])
  const player = useAudioPlayer()

  const libraryQuery = useQuery({
    queryKey: ['library'],
    queryFn: () => api.library(),
    staleTime: 10_000,
  })

  const items = libraryQuery.data?.items ?? []
  const trimmed = query.trim().toLowerCase()
  const filtered = useMemo<LibraryItem[]>(() => {
    const matched = trimmed
      ? items.filter((t) =>
          `${t.title ?? ''} ${t.artist ?? ''}`.toLowerCase().includes(trimmed),
        )
      : items
    const out = [...matched]
    if (sort === 'title') {
      out.sort((a, b) =>
        (a.title ?? '').localeCompare(b.title ?? '', undefined, { sensitivity: 'base' }),
      )
    } else if (sort === 'artist') {
      out.sort((a, b) =>
        (a.artist ?? '').localeCompare(b.artist ?? '', undefined, { sensitivity: 'base' }),
      )
    } else {
      // recent: newest added first (added_at is an ISO string → lexicographic = chronological)
      out.sort((a, b) => (b.added_at ?? '').localeCompare(a.added_at ?? ''))
    }
    return out
  }, [trimmed, items, sort])

  // Virtualize the list against the window scroll: the library can hold 10k+
  // tracks and rendering them all as DOM nodes janks scroll on mobile. The page
  // scrolls normally, so we feed the virtualizer the list's document offset
  // (scrollMargin) and absolutely-position only the visible rows.
  const listRef = useRef<HTMLDivElement | null>(null)
  const [listOffset, setListOffset] = useState(0)
  useLayoutEffect(() => {
    const measure = () => {
      if (!listRef.current) return
      const top = listRef.current.getBoundingClientRect().top + window.scrollY
      // Guard the update so re-measuring (which runs every render) can't loop.
      setListOffset((prev) => (Math.abs(prev - top) > 1 ? top : prev))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  })
  const virtualizer = useWindowVirtualizer({
    count: filtered.length,
    estimateSize: () => 76,
    overscan: 8,
    scrollMargin: listOffset,
  })

  return (
    <div className="relative z-10 min-h-full">
      <main className="max-w-6xl mx-auto px-3 sm:px-6 py-4 sm:py-8 pb-bottombars">
        <AppHeader queueCount={activeCount} />

        <div className="flex items-center gap-3 mb-5 flex-wrap">
          <Link
            to="/playlists"
            className="font-pixel text-xs uppercase tracking-widest px-2 py-1 border border-border text-ink-lo hover:text-cool hover:border-cool/70 transition rounded-xs"
          >
            ← playlists
          </Link>
          <div className="w-14 h-14 rounded-sm flex items-center justify-center bg-gradient-to-br from-hot/50 via-violet/30 to-cool/30 border border-hot/50 text-2xl text-ink-hi flex-shrink-0">
            ♥
          </div>
          <div className="min-w-0">
            <div className="font-pixel text-lg uppercase tracking-widest text-hot">
              liked songs
            </div>
            <div className="font-sans text-sm text-ink-mid">
              {items.length} track{items.length === 1 ? '' : 's'} · your favourites
            </div>
          </div>
          {filtered.length > 0 && (
            <button
              type="button"
              onClick={() => player.play(filtered, 0)}
              className="font-pixel text-xs uppercase tracking-widest px-4 py-2 border border-hot bg-hot/15 text-ink-hi shadow-[var(--shadow-glow-hot)] hover:bg-hot/25 transition rounded-xs"
            >
              ▶ play all
            </button>
          )}
        </div>

        <div className="card-vapor rounded-sm p-3 mb-6 flex items-center gap-3 font-pixel">
          <span className="text-cool text-xl">⌕</span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search your liked songs..."
            aria-label="search your liked songs"
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

        {items.length > 0 && (
          <div className="mb-4 flex items-center gap-2 flex-wrap">
            {SORTS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSort(s.id)}
                className={`font-pixel text-xs uppercase tracking-widest px-2 py-1 border rounded-xs transition ${
                  sort === s.id
                    ? 'border-cool text-cool bg-cool/10 shadow-[var(--shadow-glow-cool)]'
                    : 'border-border text-ink-lo hover:text-cool hover:border-cool/70'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}

        {libraryQuery.isLoading && (
          <div className="font-pixel text-ink-mid">··· loading ···</div>
        )}

        {libraryQuery.isError && (
          <div className="font-pixel text-crit">
            ⚠ couldn't load your songs:{' '}
            {libraryQuery.error instanceof Error ? libraryQuery.error.message : 'unknown'}
          </div>
        )}

        {libraryQuery.data && items.length === 0 && (
          <EmptyState
            glyph="⊹"
            title="no liked songs yet"
            hint="tap ♡ on any track in the catalog to save it here."
            cta={{ to: '/catalog', label: '⊕ browse the catalog' }}
          />
        )}

        {filtered.length > 0 && (
          <div ref={listRef} className="card-vapor rounded-sm overflow-hidden">
            <div
              style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}
            >
              {virtualizer.getVirtualItems().map((vi) => {
                const t = filtered[vi.index]
                return (
                  <div
                    key={`${t.video_id}/${t.codec}/${t.bitrate}`}
                    data-index={vi.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)`,
                    }}
                  >
                    <LikedRow
                      track={t}
                      position={vi.index + 1}
                      queue={filtered}
                      index={vi.index}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

function LikedRow({
  track,
  position,
  queue,
  index,
}: {
  track: LibraryItem
  position: number
  queue: LibraryItem[]
  index: number
}) {
  const player = useAudioPlayer()
  const queryClient = useQueryClient()
  const showToast = useToast()
  const remove = useMutation({
    mutationFn: () =>
      api.removeFromLibrary(track.video_id, track.codec, track.bitrate),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library'] })
      queryClient.invalidateQueries({ queryKey: ['catalog'] })
      showToast({
        message: `removed "${track.title ?? track.video_id}" from liked`,
        variant: 'success',
        action: {
          label: 'undo',
          onClick: () => {
            void api
              .catalogAdopt(track.video_id, track.codec, track.bitrate)
              .then(() => {
                queryClient.invalidateQueries({ queryKey: ['library'] })
                queryClient.invalidateQueries({ queryKey: ['catalog'] })
              })
          },
        },
      })
    },
  })
  const isCurrent =
    player.current?.video_id === track.video_id &&
    player.current?.codec === track.codec &&
    player.current?.bitrate === track.bitrate

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`play ${track.title ?? track.video_id}`}
      onClick={() => player.play(queue, index)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          player.play(queue, index)
        }
      }}
      className={`group flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2.5 sm:py-3 cursor-pointer transition border-b border-border ${
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
      <div className="flex-1 min-w-0">
        <div className="font-sans text-sm font-medium text-ink-hi leading-snug line-clamp-2">
          {track.title ?? track.video_id}
        </div>
        <div className="text-sm text-ink-mid truncate mt-0.5">
          {track.artist ?? '—'}
        </div>
      </div>
      <AddToPlaylistMenu
        trackKey={{
          video_id: track.video_id,
          codec: track.codec,
          bitrate: track.bitrate,
        }}
        track={track}
        trigger={(open) => (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              open()
            }}
            title="track actions"
            className="font-pixel text-base w-10 h-10 flex items-center justify-center border border-border text-ink-mid hover:text-cool hover:border-cool/60 transition rounded-xs"
          >
            ≣+
          </button>
        )}
      />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          if (!remove.isPending) {
            if (isCurrent) player.stop()
            remove.mutate()
          }
        }}
        disabled={remove.isPending}
        title="remove from liked"
        className="font-pixel text-base w-10 h-10 flex items-center justify-center border border-transparent text-hot hover:text-crit hover:border-crit/60 disabled:opacity-30 transition rounded-xs"
      >
        ♥
      </button>
    </div>
  )
}
