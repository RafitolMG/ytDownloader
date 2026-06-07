import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { AppHeader } from '@/shared/ui/AppHeader'
import { api } from '@/shared/api/client'
import type { LibraryItem } from '@/shared/api/types'
import { countActive, useJobs } from '@/shared/api/useJobs'
import { useAudioPlayer } from '@/features/player/AudioPlayerProvider'
import { AddToPlaylistMenu } from '@/features/playlists/AddToPlaylistMenu'

export default function LibraryPage() {
  const jobsQuery = useJobs()
  const activeCount = countActive(jobsQuery.data)
  const [query, setQuery] = useState('')

  const libraryQuery = useQuery({
    queryKey: ['library'],
    queryFn: () => api.library(500),
    staleTime: 10_000,
  })

  // Backend already returns rows ordered by added_at DESC, so the flat list
  // is "newest first" without any client-side sort.
  const items = libraryQuery.data?.items ?? []
  const trimmed = query.trim().toLowerCase()
  const filtered = useMemo<LibraryItem[]>(() => {
    if (!trimmed) return items
    return items.filter((t) => {
      const hay = `${t.title ?? ''} ${t.artist ?? ''}`.toLowerCase()
      return hay.includes(trimmed)
    })
  }, [trimmed, items])

  const player = useAudioPlayer()

  return (
    <div className="relative z-10 min-h-full">
      <main className="max-w-5xl mx-auto px-6 py-8 pb-32">
        <AppHeader queueCount={activeCount} />

        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div className="font-pixel text-xs text-ink-lo uppercase tracking-[0.2em]">
            ░▒▓ my library ▓▒░
          </div>
          {filtered.length > 0 && (
            <button
              type="button"
              onClick={() => player.play(filtered, 0)}
              className="font-pixel text-sm uppercase tracking-widest px-4 py-1 border border-hot bg-hot/15 text-ink-hi shadow-[var(--shadow-glow-hot)] hover:bg-hot/25 transition rounded-xs"
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

        {libraryQuery.data && items.length === 0 && (
          <div className="card-vapor rounded-sm p-8 text-center">
            <div className="font-pixel text-lg text-ink-mid mb-2">
              ⊹ empty library ⊹
            </div>
            <div className="font-pixel text-sm text-ink-lo">
              download a track from capture, or "+ add" something from the catalog.
            </div>
          </div>
        )}

        {libraryQuery.data && items.length > 0 && filtered.length === 0 && trimmed && (
          <div className="card-vapor rounded-sm p-8 text-center">
            <div className="font-pixel text-ink-mid">
              no tracks match "<span className="text-cool">{query}</span>"
            </div>
          </div>
        )}

        {filtered.length > 0 && (
          <ul className="card-vapor rounded-sm divide-y divide-border">
            {filtered.map((t, i) => (
              <TrackRow
                key={`${t.video_id}/${t.codec}/${t.bitrate}`}
                track={t}
                position={i + 1}
                queue={filtered}
                index={i}
              />
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}

function TrackRow({
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
  const remove = useMutation({
    mutationFn: () => api.removeFromLibrary(track.video_id, track.codec, track.bitrate),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library'] })
      queryClient.invalidateQueries({ queryKey: ['catalog'] })
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
    if (isCurrent) player.stop()
    remove.mutate()
  }

  return (
    <li
      onClick={() => player.play(queue, index)}
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
      <AddToPlaylistMenu
        trackKey={{
          video_id: track.video_id,
          codec: track.codec,
          bitrate: track.bitrate,
        }}
        trigger={(open) => (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              open()
            }}
            title="add to playlist"
            className="font-pixel text-xs uppercase tracking-widest px-2 py-1 border border-transparent text-ink-lo opacity-0 group-hover:opacity-100 hover:text-cool hover:border-cool/60 transition rounded-xs"
          >
            ≣+
          </button>
        )}
      />
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
