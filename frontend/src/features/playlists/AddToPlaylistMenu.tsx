import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '@/shared/api/client'
import type { LibraryItem } from '@/shared/api/types'
import { useAudioPlayer } from '@/features/player/AudioPlayerProvider'

type TrackKey = { video_id: string; codec: string; bitrate: string }

type Props = {
  trackKey: TrackKey
  /** Full track — when provided, the menu also offers play-next / add-to-queue. */
  track?: LibraryItem
  /** When provided, the menu offers "more like this" (start a radio). */
  onRadio?: () => void
  /** Render-prop trigger so the host can style the button however it wants. */
  trigger: (open: () => void) => React.ReactNode
}

/** Inline per-track actions menu: queue the track (play next / add to queue),
 * start a radio, and add it to a playlist. Opens beneath the trigger. */
export function AddToPlaylistMenu({ trackKey, track, onRadio, trigger }: Props) {
  const player = useAudioPlayer()
  const [open, setOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const qc = useQueryClient()

  const playlistsQuery = useQuery({
    queryKey: ['playlists', 'mine'],
    queryFn: () => api.playlists({ owner: 'me' }),
    enabled: open,
    staleTime: 5_000,
  })

  // Dismiss on outside-click / Escape.
  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const addMut = useMutation({
    mutationFn: (playlistId: string) => api.addToPlaylist(playlistId, trackKey),
    onMutate: (id) => setBusyId(id),
    onSettled: () => setBusyId(null),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['playlists'] })
      qc.invalidateQueries({ queryKey: ['playlist', id] })
      setOpen(false)
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'failed'),
  })

  const createAndAdd = useMutation({
    mutationFn: async () => {
      const name = newName.trim()
      if (!name) throw new Error('name required')
      const { id } = await api.createPlaylist({ name, visibility: 'private' })
      await api.addToPlaylist(id, trackKey)
      return id
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['playlists'] })
      setNewName('')
      setOpen(false)
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'failed'),
  })

  return (
    <div className="relative inline-block" ref={popoverRef}>
      {trigger(() => {
        setError(null)
        setOpen((v) => !v)
      })}
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-50 w-72 card-vapor rounded-sm p-3 shadow-[var(--shadow-glow-cool)]"
          onClick={(e) => e.stopPropagation()}
        >
          {(track || onRadio) && (
            <div className="mb-2 pb-2 border-b border-border/60 flex flex-col gap-1">
              {track && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      player.playNext(track)
                      setOpen(false)
                    }}
                    className="w-full text-left px-2 py-1.5 hover:bg-violet/10 transition rounded-xs font-sans text-sm text-ink-hi flex items-center gap-2"
                  >
                    <span className="text-cool">▶</span> play next
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      player.enqueue(track)
                      setOpen(false)
                    }}
                    className="w-full text-left px-2 py-1.5 hover:bg-violet/10 transition rounded-xs font-sans text-sm text-ink-hi flex items-center gap-2"
                  >
                    <span className="text-cool">≣</span> add to queue
                  </button>
                </>
              )}
              {onRadio && (
                <button
                  type="button"
                  onClick={() => {
                    onRadio()
                    setOpen(false)
                  }}
                  className="w-full text-left px-2 py-1.5 hover:bg-violet/10 transition rounded-xs font-sans text-sm text-ink-hi flex items-center gap-2"
                >
                  <span className="text-cool">≈</span> more like this
                </button>
              )}
            </div>
          )}

          <div className="font-pixel text-xs uppercase tracking-[0.2em] text-cool mb-2">
            ░ add to playlist ░
          </div>

          {playlistsQuery.isLoading && (
            <div className="font-pixel text-xs text-ink-lo">loading…</div>
          )}

          {playlistsQuery.data && (
            <ul className="max-h-48 overflow-y-auto divide-y divide-border mb-2">
              {playlistsQuery.data.items
                .filter((p) => p.is_owner)
                .map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => addMut.mutate(p.id)}
                      disabled={busyId === p.id}
                      className="w-full flex items-center justify-between text-left px-2 py-1.5 hover:bg-violet/10 transition rounded-xs disabled:opacity-40"
                    >
                      <span className="font-sans text-sm text-ink-hi truncate">
                        {p.name}
                      </span>
                      <span className="font-pixel text-xs text-ink-lo uppercase tracking-widest">
                        {p.visibility === 'public' ? '◉' : '◌'} {p.track_count}
                      </span>
                    </button>
                  </li>
                ))}
              {playlistsQuery.data.items.filter((p) => p.is_owner).length === 0 && (
                <li className="font-pixel text-xs text-ink-lo py-2">
                  no playlists yet — create one below.
                </li>
              )}
            </ul>
          )}

          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (createAndAdd.isPending) return
              if (newName.trim()) createAndAdd.mutate()
            }}
          >
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="new playlist name"
              className="flex-1 bg-page text-ink-hi placeholder:text-ink-lo px-2 py-1 text-sm border border-border rounded-xs outline-none focus:border-cool"
            />
            <button
              type="submit"
              disabled={!newName.trim() || createAndAdd.isPending}
              className="font-pixel text-xs uppercase tracking-widest px-2 py-1 border border-hot text-hot hover:bg-hot/15 disabled:opacity-30 rounded-xs transition"
            >
              + new
            </button>
          </form>

          {error && (
            <div className="font-pixel text-xs text-crit mt-2 break-words">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
