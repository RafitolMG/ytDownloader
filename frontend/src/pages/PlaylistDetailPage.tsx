import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { AppHeader } from '@/shared/ui/AppHeader'
import { ConfirmButton } from '@/shared/ui/ConfirmButton'
import { NowPlayingTick } from '@/shared/ui/NowPlayingTick'
import { useToast } from '@/shared/ui/ToastProvider'
import { api } from '@/shared/api/client'
import type {
  PlaylistTrackRow,
  PlaylistVisibility,
} from '@/shared/api/types'
import { countActive, useJobs } from '@/shared/api/useJobs'
import { fmtDuration } from '@/shared/lib/format'
import { playlistRowToLibrary as toLibraryItem } from '@/shared/lib/libraryItem'
import { useAudioPlayer } from '@/features/player/AudioPlayerProvider'
import { useOffline } from '@/features/offline/OfflineProvider'
import { offlineIndex } from '@/features/offline/offlineIndex'

export default function PlaylistDetailPage() {
  const { id = '' } = useParams<{ id: string }>()
  // Remount on id change: React Router reuses this component instance across
  // /playlists/:id navigations, so without a key the optimistic `localTracks`
  // (and a pending reorder) would bleed from the previous playlist into the
  // next until its query resolves.
  return <PlaylistDetailView key={id} />
}

function PlaylistDetailView() {
  const { id = '' } = useParams<{ id: string }>()
  const jobsQuery = useJobs()
  const activeCount = countActive(jobsQuery.data)
  const navigate = useNavigate()
  const qc = useQueryClient()
  const showToast = useToast()

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
    onSuccess: (_data, key) => {
      qc.invalidateQueries({ queryKey: ['playlist', id] })
      qc.invalidateQueries({ queryKey: ['playlists'] })
      showToast({
        message: 'removed from playlist',
        variant: 'success',
        action: {
          label: 'undo',
          onClick: () => {
            void api.addToPlaylist(id, key).then(() => {
              qc.invalidateQueries({ queryKey: ['playlist', id] })
              qc.invalidateQueries({ queryKey: ['playlists'] })
            })
          },
        },
      })
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
  const off = useOffline()

  if (playlistQuery.isLoading) {
    return (
      <main className="max-w-6xl mx-auto px-3 sm:px-6 py-4 sm:py-8">
        <div className="font-pixel text-ink-mid">··· loading playlist ···</div>
      </main>
    )
  }
  if (playlistQuery.isError || !playlistQuery.data) {
    // The fetch failed (most likely offline). If this playlist was downloaded,
    // fall back to its on-device copy so it still opens and plays with no net.
    const offlineTracks = off.offlineTracksFor(id)
    if (offlineTracks.length > 0) {
      return (
        <OfflinePlaylistView
          name={off.playlistName(id) ?? 'downloaded playlist'}
          tracks={offlineTracks}
          queueCount={activeCount}
        />
      )
    }
    return (
      <main className="max-w-6xl mx-auto px-3 sm:px-6 py-4 sm:py-8">
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
      <main className="max-w-6xl mx-auto px-3 sm:px-6 py-4 sm:py-8 pb-bottombars">
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
            <div className="font-pixel text-sm text-ink-mid uppercase tracking-widest mt-2">
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
            {tracks.length > 0 && (
              <DownloadPlaylistButton
                playlistId={playlist.id}
                playlistName={playlist.name}
                tracks={tracks}
              />
            )}
            {playlist.visibility === 'public' && <ShareButton id={playlist.id} />}
            {tracks.length > 0 && (
              <ExportButton name={playlist.name} description={playlist.description} tracks={tracks} />
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
              <ConfirmButton
                onConfirm={() => deletePlaylist.mutate()}
                disabled={deletePlaylist.isPending}
                idle="✕ delete"
                title={`delete "${playlist.name}" — can't be undone`}
              />
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

/** Read-only render of a downloaded playlist from the on-device manifest, shown
 *  when the network fetch fails. Plays straight from the local files. */
function OfflinePlaylistView({
  name,
  tracks,
  queueCount,
}: {
  name: string
  tracks: PlaylistTrackRow[]
  queueCount: number
}) {
  const player = useAudioPlayer()

  function playAll(startAt = 0) {
    const queue = tracks.map(toLibraryItem)
    if (queue.length > 0) player.play(queue, Math.max(0, startAt))
  }

  return (
    <div className="relative z-10 min-h-full">
      <main className="max-w-6xl mx-auto px-3 sm:px-6 py-4 sm:py-8 pb-bottombars">
        <AppHeader queueCount={queueCount} />

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
            <div className="font-pixel text-xs uppercase tracking-[0.2em] text-hot mb-1">
              ⬇ offline · no connection
            </div>
            <h1 className="font-sans text-2xl font-bold text-ink-hi">{name}</h1>
            <div className="font-pixel text-xs text-ink-lo uppercase tracking-widest mt-2">
              {tracks.length} track{tracks.length === 1 ? '' : 's'} on device
            </div>
          </div>
          <button
            type="button"
            onClick={() => playAll(0)}
            className="font-pixel text-sm uppercase tracking-widest px-4 py-1 border border-hot bg-hot/15 text-ink-hi shadow-[var(--shadow-glow-hot)] hover:bg-hot/25 transition rounded-xs"
          >
            ▶ play all
          </button>
        </header>

        <ul className="card-vapor rounded-sm divide-y divide-border">
          {tracks.map((t, i) => (
            <TrackRow
              key={`${t.video_id}/${t.codec}/${t.bitrate}`}
              track={t}
              position={i}
              isOwner={false}
              onPlay={() => playAll(i)}
              onDropAt={() => {}}
              onRemove={() => {}}
            />
          ))}
        </ul>
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
  const off = useOffline()
  const [over, setOver] = useState(false)

  const isOffline = off.isDownloaded(track.video_id, track.codec, track.bitrate)
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
      className={`flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2.5 sm:py-3 cursor-pointer transition group ${
        isCurrent ? 'bg-hot/10' : 'hover:bg-violet/10'
      } ${over ? 'border-t-2 border-cool' : ''}`}
    >
      {isOwner && (
        <span
          className="font-pixel text-sm text-ink-lo/60 cursor-grab select-none hidden sm:inline"
          title="drag to reorder"
        >
          ⋮⋮
        </span>
      )}
      <div className="font-pixel text-xs sm:text-sm text-ink-lo w-6 sm:w-8 text-right tabular-nums">
        {isCurrent ? (
          <NowPlayingTick playing={player.isPlaying} />
        ) : (
          String(position + 1).padStart(2, '0')
        )}
      </div>

      <div className="relative w-14 sm:w-20 aspect-video flex-shrink-0 rounded-xs overflow-hidden border border-border bg-page-mid">
        {offlineIndex.getCover(track.video_id) ?? track.thumbnail_url ? (
          <img
            src={offlineIndex.getCover(track.video_id) ?? track.thumbnail_url ?? undefined}
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
        {isOffline && (
          <span
            title="downloaded for offline"
            className="absolute top-0.5 left-0.5 font-pixel text-[10px] leading-none bg-page/80 text-hot px-1 py-0.5 rounded-xs"
          >
            ⬇
          </span>
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

      {isOwner && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          title="remove from playlist"
          className="font-pixel text-base w-10 h-10 flex items-center justify-center border border-transparent text-ink-lo opacity-100 lg:opacity-0 lg:group-hover:opacity-100 hover:text-crit hover:border-crit/60 transition rounded-xs"
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

/** Download every track of this playlist to the device for offline playback
 *  (native only). Idle → progress → "✓ offline" with a two-step remove. */
function DownloadPlaylistButton({
  playlistId,
  playlistName,
  tracks,
}: {
  playlistId: string
  playlistName: string
  tracks: PlaylistTrackRow[]
}) {
  const off = useOffline()
  const [armedRemove, setArmedRemove] = useState(false)

  if (!off.supported) return null

  const real = tracks.filter((t) => t.codec !== 'preview')
  const total = real.length
  if (total === 0) return null

  const progress = off.progressFor(playlistId)
  if (progress) {
    return (
      <span className="font-pixel text-sm uppercase tracking-widest px-4 py-1 border border-cool/60 text-cool rounded-xs">
        ··· {progress.done}/{progress.total}
      </span>
    )
  }

  const done = real.filter((t) =>
    off.isDownloaded(t.video_id, t.codec, t.bitrate),
  ).length

  if (done === total) {
    if (armedRemove) {
      return (
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              void off.removePlaylist(playlistId)
              setArmedRemove(false)
            }}
            title="confirm — delete downloaded files"
            className="font-pixel text-sm uppercase tracking-widest px-2 py-1 border border-crit/60 text-crit bg-crit/10 hover:bg-crit/20 transition rounded-xs"
          >
            ⚠ remove
          </button>
          <button
            type="button"
            onClick={() => setArmedRemove(false)}
            title="cancel"
            className="font-pixel text-sm uppercase tracking-widest px-2 py-1 border border-border text-ink-lo hover:text-cool transition rounded-xs"
          >
            ✕
          </button>
        </span>
      )
    }
    return (
      <button
        type="button"
        onClick={() => setArmedRemove(true)}
        title="downloaded for offline — tap to remove"
        className="font-pixel text-sm uppercase tracking-widest px-4 py-1 border border-cool bg-cool/10 text-cool shadow-[var(--shadow-glow-cool)] hover:bg-cool/20 transition rounded-xs"
      >
        ✓ offline
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={() => void off.downloadPlaylist(playlistId, playlistName, tracks)}
      title="download for offline playback"
      className="font-pixel text-sm uppercase tracking-widest px-4 py-1 border border-cool/60 text-cool hover:bg-cool/10 transition rounded-xs"
    >
      ⬇ {done > 0 ? `${done}/${total}` : 'download'}
    </button>
  )
}

/** Copy a shareable link to this (public) playlist. Any logged-in user can open
 * it via the normal /playlists/:id route — public playlists are viewable. */
function ShareButton({ id }: { id: string }) {
  const showToast = useToast()
  return (
    <button
      type="button"
      onClick={async () => {
        const url = `${window.location.origin}/playlists/${id}`
        try {
          await navigator.clipboard.writeText(url)
          showToast({ message: 'share link copied', variant: 'success' })
        } catch {
          showToast({ message: url, variant: 'info' })
        }
      }}
      title="copy a link to this public playlist"
      className="focus-vis font-pixel text-sm uppercase tracking-widest px-3 py-1 border border-cool/60 text-cool hover:bg-cool/10 transition rounded-xs"
    >
      ◈ share
    </button>
  )
}

/** Download this playlist as portable JSON (importable on Playlists). */
function ExportButton({
  name,
  description,
  tracks,
}: {
  name: string
  description: string | null
  tracks: PlaylistTrackRow[]
}) {
  const onExport = () => {
    const data = {
      name,
      description,
      tracks: tracks.map((t) => ({
        video_id: t.video_id,
        codec: t.codec,
        bitrate: t.bitrate,
        title: t.title,
        artist: t.artist,
      })),
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${name.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'playlist'}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }
  return (
    <button
      type="button"
      onClick={onExport}
      title="download this playlist as JSON"
      className="focus-vis font-pixel text-sm uppercase tracking-widest px-3 py-1 border border-border text-ink-lo hover:text-cool hover:border-cool/70 transition rounded-xs"
    >
      ⬇ export
    </button>
  )
}
