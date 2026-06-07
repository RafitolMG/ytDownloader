import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { AppHeader } from '@/shared/ui/AppHeader'
import { api } from '@/shared/api/client'
import type {
  LibraryItem,
  PlaylistTrackRow,
  PlaylistVisibility,
} from '@/shared/api/types'
import { countActive, useJobs } from '@/shared/api/useJobs'
import { useAudioPlayer } from '@/features/player/AudioPlayerProvider'

function toLibraryItem(t: PlaylistTrackRow): LibraryItem {
  return {
    video_id: t.video_id,
    codec: t.codec,
    bitrate: t.bitrate,
    title: t.title,
    artist: t.artist,
    duration_sec: t.duration_sec,
    thumbnail_url: t.thumbnail_url,
    source_url: t.source_url,
    file_size: t.file_size,
    added_at: t.added_at,
    source_playlist_title: null,
  }
}

export default function PlaylistDetailPage() {
  const { id = '' } = useParams<{ id: string }>()
  const jobsQuery = useJobs()
  const activeCount = countActive(jobsQuery.data)
  const navigate = useNavigate()
  const qc = useQueryClient()

  const playlistQuery = useQuery({
    queryKey: ['playlist', id],
    queryFn: () => api.playlist(id),
    enabled: !!id,
  })

  // Local optimistic order so drag-and-drop feels instant. Synced from server
  // every time the query refetches.
  const [localTracks, setLocalTracks] = useState<PlaylistTrackRow[] | null>(null)
  useEffect(() => {
    if (playlistQuery.data) {
      setLocalTracks(playlistQuery.data.tracks)
    }
  }, [playlistQuery.data])

  const reorder = useMutation({
    mutationFn: (ordered: PlaylistTrackRow[]) =>
      api.reorderPlaylist(
        id,
        ordered.map((t) => ({
          video_id: t.video_id,
          codec: t.codec,
          bitrate: t.bitrate,
        })),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['playlist', id] })
    },
  })

  const remove = useMutation({
    mutationFn: (key: { video_id: string; codec: string; bitrate: string }) =>
      api.removeFromPlaylist(id, key.video_id, key.codec, key.bitrate),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['playlist', id] })
      qc.invalidateQueries({ queryKey: ['playlists'] })
    },
  })

  const deletePlaylist = useMutation({
    mutationFn: () => api.deletePlaylist(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['playlists'] })
      navigate('/playlists')
    },
  })

  const player = useAudioPlayer()

  if (playlistQuery.isLoading) {
    return (
      <main className="max-w-5xl mx-auto px-6 py-8">
        <div className="font-pixel text-ink-mid">··· loading playlist ···</div>
      </main>
    )
  }
  if (playlistQuery.isError || !playlistQuery.data) {
    return (
      <main className="max-w-5xl mx-auto px-6 py-8">
        <div className="font-pixel text-crit">
          could not load playlist —{' '}
          {playlistQuery.error instanceof Error
            ? playlistQuery.error.message
            : 'unknown'}
        </div>
        <Link
          to="/playlists"
          className="inline-block mt-4 font-pixel text-sm uppercase tracking-widest px-3 py-1 border border-border text-ink-mid hover:text-cool hover:border-cool/70 transition rounded-xs"
        >
          ◀ all playlists
        </Link>
      </main>
    )
  }

  const playlist = playlistQuery.data
  const tracks = localTracks ?? playlist.tracks

  function handleDrop(from: number, to: number) {
    if (from === to || !tracks) return
    const next = tracks.slice()
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setLocalTracks(next)
    reorder.mutate(next)
  }

  function playAll(startAt = 0) {
    const queue = tracks.map(toLibraryItem)
    if (queue.length > 0) player.play(queue, Math.max(0, startAt))
  }

  return (
    <div className="relative z-10 min-h-full">
      <main className="max-w-5xl mx-auto px-6 py-8 pb-32">
        <AppHeader queueCount={activeCount} />

        <div className="mb-3">
          <Link
            to="/playlists"
            className="font-pixel text-xs uppercase tracking-widest text-ink-lo hover:text-cool transition"
          >
            ◀ playlists
          </Link>
        </div>

        <header className="card-vapor rounded-sm p-5 mb-6 flex items-center gap-4 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="font-pixel text-xs uppercase tracking-[0.2em] text-cool mb-1">
              {playlist.visibility === 'public' ? '◉ public playlist' : '◌ private playlist'}
            </div>
            <h1 className="font-sans text-2xl font-bold text-ink-hi">
              {playlist.name}
            </h1>
            {playlist.description && (
              <p className="text-sm text-ink-mid mt-1">{playlist.description}</p>
            )}
            <div className="font-pixel text-xs text-ink-lo uppercase tracking-widest mt-2">
              {tracks.length} track{tracks.length === 1 ? '' : 's'}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {tracks.length > 0 && (
              <button
                type="button"
                onClick={() => playAll(0)}
                className="font-pixel text-sm uppercase tracking-widest px-4 py-1 border border-hot bg-hot/15 text-ink-hi shadow-[var(--shadow-glow-hot)] hover:bg-hot/25 transition rounded-xs"
              >
                ▶ play all
              </button>
            )}
            {playlist.is_owner && (
              <EditPlaylistButton
                id={playlist.id}
                name={playlist.name}
                description={playlist.description}
                visibility={playlist.visibility}
              />
            )}
            {playlist.is_owner && (
              <button
                type="button"
                onClick={() => {
                  if (
                    window.confirm(`Delete "${playlist.name}"? This can't be undone.`)
                  ) {
                    deletePlaylist.mutate()
                  }
                }}
                disabled={deletePlaylist.isPending}
                className="font-pixel text-sm uppercase tracking-widest px-3 py-1 border border-crit/60 text-crit hover:bg-crit/10 disabled:opacity-30 transition rounded-xs"
              >
                ✕ delete
              </button>
            )}
          </div>
        </header>

        {tracks.length === 0 ? (
          <div className="card-vapor rounded-sm p-8 text-center">
            <div className="font-pixel text-lg text-ink-mid mb-2">
              ⊹ no tracks yet ⊹
            </div>
            <div className="font-pixel text-sm text-ink-lo">
              {playlist.is_owner
                ? 'add tracks from the catalog or your library.'
                : 'this playlist is empty.'}
            </div>
          </div>
        ) : (
          <ul className="card-vapor rounded-sm divide-y divide-border">
            {tracks.map((t, i) => (
              <TrackRow
                key={`${t.video_id}/${t.codec}/${t.bitrate}`}
                track={t}
                position={i}
                isOwner={playlist.is_owner}
                onPlay={() => playAll(i)}
                onDropAt={(from) => handleDrop(from, i)}
                onRemove={() =>
                  remove.mutate({
                    video_id: t.video_id,
                    codec: t.codec,
                    bitrate: t.bitrate,
                  })
                }
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
  isOwner,
  onPlay,
  onDropAt,
  onRemove,
}: {
  track: PlaylistTrackRow
  position: number
  isOwner: boolean
  onPlay: () => void
  onDropAt: (fromIndex: number) => void
  onRemove: () => void
}) {
  const player = useAudioPlayer()
  const [over, setOver] = useState(false)

  const isCurrent =
    player.current?.video_id === track.video_id &&
    player.current?.codec === track.codec &&
    player.current?.bitrate === track.bitrate

  return (
    <li
      onClick={onPlay}
      draggable={isOwner}
      onDragStart={(e) => {
        if (!isOwner) return
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', String(position))
      }}
      onDragOver={(e) => {
        if (!isOwner) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (!over) setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!isOwner) return
        e.preventDefault()
        setOver(false)
        const from = Number(e.dataTransfer.getData('text/plain'))
        if (!Number.isNaN(from)) onDropAt(from)
      }}
      className={`flex items-center gap-3 px-3 py-2 cursor-pointer transition group ${
        isCurrent ? 'bg-hot/10' : 'hover:bg-violet/10'
      } ${over ? 'border-t-2 border-cool' : ''}`}
    >
      {isOwner && (
        <span
          className="font-pixel text-sm text-ink-lo/60 cursor-grab select-none"
          title="drag to reorder"
        >
          ⋮⋮
        </span>
      )}
      <div className="font-pixel text-sm text-ink-lo w-8 text-right tabular-nums">
        {isCurrent && player.isPlaying ? (
          <span className="text-hot">▶</span>
        ) : (
          String(position + 1).padStart(2, '0')
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

      {isOwner && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          title="remove from playlist"
          className="font-pixel text-sm uppercase tracking-widest w-7 h-7 flex items-center justify-center border border-transparent text-ink-lo opacity-0 group-hover:opacity-100 hover:text-crit hover:border-crit/60 transition rounded-xs"
        >
          ✕
        </button>
      )}
    </li>
  )
}

function EditPlaylistButton({
  id,
  name,
  description,
  visibility,
}: {
  id: string
  name: string
  description: string | null
  visibility: PlaylistVisibility
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="font-pixel text-sm uppercase tracking-widest px-3 py-1 border border-border text-ink-mid hover:text-cool hover:border-cool/70 transition rounded-xs"
      >
        ✎ edit
      </button>
      {open && (
        <EditDialog
          id={id}
          initialName={name}
          initialDescription={description ?? ''}
          initialVisibility={visibility}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function EditDialog({
  id,
  initialName,
  initialDescription,
  initialVisibility,
  onClose,
}: {
  id: string
  initialName: string
  initialDescription: string
  initialVisibility: PlaylistVisibility
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState(initialDescription)
  const [visibility, setVisibility] = useState<PlaylistVisibility>(initialVisibility)

  const save = useMutation({
    mutationFn: () =>
      api.updatePlaylist(id, {
        name: name.trim(),
        description: description.trim() || null,
        visibility,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['playlist', id] })
      qc.invalidateQueries({ queryKey: ['playlists'] })
      onClose()
    },
  })

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-page/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim() && !save.isPending) save.mutate()
        }}
        className="card-vapor rounded-sm p-5 w-full max-w-md mx-4 shadow-[var(--shadow-glow-cool)]"
      >
        <div className="font-pixel text-xs uppercase tracking-[0.2em] text-cool mb-4">
          ░ edit playlist ░
        </div>
        <label className="block mb-3">
          <div className="font-pixel text-xs text-ink-lo uppercase tracking-widest mb-1">
            name
          </div>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-page text-ink-hi px-3 py-2 border border-border rounded-xs outline-none focus:border-cool"
          />
        </label>
        <label className="block mb-3">
          <div className="font-pixel text-xs text-ink-lo uppercase tracking-widest mb-1">
            description
          </div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full bg-page text-ink-hi px-3 py-2 border border-border rounded-xs outline-none focus:border-cool resize-none"
          />
        </label>
        <div className="flex items-center gap-2 mb-4">
          <span className="font-pixel text-xs text-ink-lo uppercase tracking-widest">
            visibility:
          </span>
          {(['private', 'public'] as PlaylistVisibility[]).map((v) => (
            <button
              type="button"
              key={v}
              onClick={() => setVisibility(v)}
              className={`font-pixel text-xs uppercase tracking-widest px-2 py-1 border rounded-xs transition ${
                visibility === v
                  ? 'border-cool text-cool bg-cool/10 shadow-[var(--shadow-glow-cool)]'
                  : 'border-border text-ink-lo hover:text-cool hover:border-cool/70'
              }`}
            >
              {v === 'public' ? '◉ public' : '◌ private'}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="font-pixel text-sm uppercase tracking-widest px-3 py-1 border border-border text-ink-lo hover:text-crit hover:border-crit/60 transition rounded-xs"
          >
            cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || save.isPending}
            className="font-pixel text-sm uppercase tracking-widest px-3 py-1 border border-hot bg-hot/15 text-ink-hi shadow-[var(--shadow-glow-hot)] hover:bg-hot/25 disabled:opacity-30 transition rounded-xs"
          >
            save
          </button>
        </div>
      </form>
    </div>
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
