import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { AppHeader } from '@/shared/ui/AppHeader'
import { api } from '@/shared/api/client'
import type { LibraryItem } from '@/shared/api/types'
import { countActive, useJobs } from '@/shared/api/useJobs'
import { useAudioPlayer } from '@/features/player/AudioPlayerProvider'

type Group = {
  /** Synthetic key — playlist title or '__loose__' for tracks not from a playlist. */
  key: string
  label: string
  tracks: LibraryItem[]
  /** First track's thumbnail, used as group cover. */
  cover: string | null
}

export default function LibraryPage() {
  const jobsQuery = useJobs()
  const activeCount = countActive(jobsQuery.data)

  const libraryQuery = useQuery({
    queryKey: ['library'],
    queryFn: () => api.library(500),
    staleTime: 10_000,
  })

  const groups = useMemo<Group[]>(() => {
    const items = libraryQuery.data?.items ?? []
    const byKey = new Map<string, Group>()
    for (const t of items) {
      const key = t.source_playlist_title ?? '__loose__'
      const label = t.source_playlist_title ?? 'singles'
      let g = byKey.get(key)
      if (!g) {
        g = { key, label, tracks: [], cover: t.thumbnail_url }
        byKey.set(key, g)
      }
      g.tracks.push(t)
      if (!g.cover && t.thumbnail_url) g.cover = t.thumbnail_url
    }
    return Array.from(byKey.values()).sort((a, b) => b.tracks.length - a.tracks.length)
  }, [libraryQuery.data])

  const [openKey, setOpenKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const openGroup = groups.find((g) => g.key === openKey) ?? null

  const trimmed = query.trim().toLowerCase()
  const filtered = useMemo<LibraryItem[]>(() => {
    if (!trimmed) return []
    const items = libraryQuery.data?.items ?? []
    return items.filter((t) => {
      const hay = `${t.title ?? ''} ${t.artist ?? ''} ${t.source_playlist_title ?? ''}`.toLowerCase()
      return hay.includes(trimmed)
    })
  }, [trimmed, libraryQuery.data])

  return (
    <div className="relative z-10 min-h-full">
      <main className="max-w-5xl mx-auto px-6 py-8 pb-32">
        <AppHeader queueCount={activeCount} />

        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div className="font-pixel text-xs text-ink-lo uppercase tracking-[0.2em]">
            ░▒▓ music library ▓▒░
          </div>
          {openGroup && !trimmed && (
            <button
              type="button"
              onClick={() => setOpenKey(null)}
              className="font-pixel text-sm uppercase tracking-widest px-3 py-1 border border-border text-ink-mid hover:text-cool hover:border-cool/70 transition rounded-xs"
            >
              ◀ all playlists
            </button>
          )}
        </div>

        <div className="card-vapor rounded-sm p-3 mb-6 flex items-center gap-3 font-pixel">
          <span className="text-cool text-xl">⌕</span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search in your library..."
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

        {libraryQuery.isLoading && (
          <div className="font-pixel text-ink-mid">··· loading library ···</div>
        )}
        {libraryQuery.isError && (
          <div className="font-pixel text-crit">
            failed to load library:{' '}
            {libraryQuery.error instanceof Error ? libraryQuery.error.message : 'unknown'}
          </div>
        )}

        {libraryQuery.data && groups.length === 0 && (
          <div className="card-vapor rounded-sm p-8 text-center">
            <div className="font-pixel text-lg text-ink-mid mb-2">
              ⊹ empty library ⊹
            </div>
            <div className="font-pixel text-sm text-ink-lo">
              import a playlist from the capture page to start your collection.
            </div>
          </div>
        )}

        {trimmed ? (
          <SearchResults query={query} matches={filtered} />
        ) : openGroup ? (
          <TrackList group={openGroup} />
        ) : (
          groups.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {groups.map((g) => (
                <PlaylistCard key={g.key} group={g} onOpen={() => setOpenKey(g.key)} />
              ))}
            </div>
          )
        )}
      </main>
    </div>
  )
}

function SearchResults({ query, matches }: { query: string; matches: LibraryItem[] }) {
  const player = useAudioPlayer()
  if (matches.length === 0) {
    return (
      <div className="card-vapor rounded-sm p-8 text-center">
        <div className="font-pixel text-ink-mid">
          no tracks match "<span className="text-cool">{query}</span>"
        </div>
      </div>
    )
  }
  return (
    <section className="card-vapor rounded-sm">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div className="font-pixel text-xs text-ink-lo uppercase tracking-[0.2em]">
          // {matches.length} match{matches.length === 1 ? '' : 'es'}
        </div>
        <button
          type="button"
          onClick={() => player.play(matches, 0)}
          className="font-pixel text-sm uppercase tracking-widest px-4 py-1 border border-hot bg-hot/15 text-ink-hi shadow-[var(--shadow-glow-hot)] hover:bg-hot/25 transition rounded-xs"
        >
          ▶ play all
        </button>
      </div>
      <ul className="divide-y divide-border max-h-[32rem] overflow-y-auto">
        {matches.map((t, i) => (
          <TrackRow
            key={`${t.video_id}/${t.codec}/${t.bitrate}`}
            track={t}
            position={i + 1}
            onPlay={() => player.play(matches, i)}
          />
        ))}
      </ul>
    </section>
  )
}

function PlaylistCard({ group, onOpen }: { group: Group; onOpen: () => void }) {
  const player = useAudioPlayer()
  return (
    <div className="card-vapor rounded-sm overflow-hidden flex flex-col group">
      <button
        type="button"
        onClick={onOpen}
        className="relative aspect-video overflow-hidden bg-page-mid img-chromatic block"
      >
        {group.cover ? (
          <img
            src={group.cover}
            alt=""
            className="w-full h-full object-cover transition group-hover:scale-105"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-violet/40 via-hot/20 to-cool/30" />
        )}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage:
              'repeating-linear-gradient(to bottom, transparent 0px, transparent 2px, rgba(0,0,0,0.25) 2px, rgba(0,0,0,0.25) 3px)',
          }}
        />
      </button>
      <div className="p-3 flex-1 flex flex-col gap-2">
        <div className="flex-1 min-w-0">
          <div className="font-sans text-sm font-semibold text-ink-hi leading-snug line-clamp-2">
            {group.label}
          </div>
          <div className="font-pixel text-xs text-ink-lo uppercase tracking-widest mt-1">
            {group.tracks.length} track{group.tracks.length === 1 ? '' : 's'}
          </div>
        </div>
        <button
          type="button"
          onClick={() => player.play(group.tracks, 0)}
          className="font-pixel text-sm uppercase tracking-widest px-3 py-1 border border-hot bg-hot/15 text-ink-hi shadow-[var(--shadow-glow-hot)] hover:bg-hot/25 transition rounded-xs"
        >
          ▶ play all
        </button>
      </div>
    </div>
  )
}

function TrackList({ group }: { group: Group }) {
  const player = useAudioPlayer()
  return (
    <section className="card-vapor rounded-sm">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div>
          <div className="font-pixel text-xs text-ink-lo uppercase tracking-[0.2em]">
            // playlist
          </div>
          <div className="font-sans text-lg font-semibold text-ink-hi mt-1">
            {group.label}
          </div>
        </div>
        <button
          type="button"
          onClick={() => player.play(group.tracks, 0)}
          className="font-pixel text-sm uppercase tracking-widest px-4 py-1 border border-hot bg-hot/15 text-ink-hi shadow-[var(--shadow-glow-hot)] hover:bg-hot/25 transition rounded-xs"
        >
          ▶ play all
        </button>
      </div>
      <ul className="divide-y divide-border max-h-[32rem] overflow-y-auto">
        {group.tracks.map((t, i) => (
          <TrackRow
            key={`${t.video_id}/${t.codec}/${t.bitrate}`}
            track={t}
            position={i + 1}
            onPlay={() => player.play(group.tracks, i)}
          />
        ))}
      </ul>
    </section>
  )
}

function TrackRow({
  track,
  position,
  onPlay,
}: {
  track: LibraryItem
  position: number
  onPlay: () => void
}) {
  const player = useAudioPlayer()
  const queryClient = useQueryClient()
  const remove = useMutation({
    mutationFn: () => api.removeFromLibrary(track.video_id, track.codec, track.bitrate),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library'] })
    },
  })
  const isCurrent =
    player.current?.video_id === track.video_id &&
    player.current?.codec === track.codec &&
    player.current?.bitrate === track.bitrate

  function handleRemove(e: React.MouseEvent) {
    e.stopPropagation()
    if (remove.isPending) return
    const ok = window.confirm(`Remove "${track.title ?? track.video_id}" from your library?`)
    if (!ok) return
    // If we're removing the track that's currently playing, stop it first so
    // the player doesn't get stuck pointing at a deleted file.
    if (isCurrent) player.stop()
    remove.mutate()
  }

  return (
    <li
      onClick={onPlay}
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
        {track.duration_sec != null && (
          <span className="absolute bottom-0.5 right-0.5 font-pixel text-[10px] leading-none bg-page/80 text-cool px-1 py-0.5 rounded-xs">
            {fmtDuration(track.duration_sec)}
          </span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-sans text-sm font-medium text-ink-hi leading-snug line-clamp-2">
          {track.title ?? track.video_id}
        </div>
        <div className="text-sm text-ink-lo truncate mt-0.5">
          {track.artist ?? '—'}
        </div>
      </div>
      <button
        type="button"
        onClick={handleRemove}
        disabled={remove.isPending}
        title="remove from library"
        className="font-pixel text-sm uppercase tracking-widest w-7 h-7 flex items-center justify-center border border-transparent text-ink-lo opacity-0 group-hover:opacity-100 hover:text-crit hover:border-crit/60 disabled:opacity-30 transition rounded-xs"
      >
        ✕
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
