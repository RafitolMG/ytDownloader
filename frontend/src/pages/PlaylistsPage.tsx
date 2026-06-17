import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AppHeader } from '@/shared/ui/AppHeader'
import { useToast } from '@/shared/ui/ToastProvider'
import { api } from '@/shared/api/client'
import type { PlaylistSummary, PlaylistVisibility } from '@/shared/api/types'
import { countActive, useJobs } from '@/shared/api/useJobs'

/** Pinned "Liked Songs" tile — the user's saved tracks, Spotify-style, living
 * here in Playlists rather than in the catalog. */
function LikedSongsCard({ count }: { count: number }) {
  return (
    <Link
      to="/playlists/liked"
      className="card-vapor rounded-sm overflow-hidden flex flex-col group hover:border-hot/60 transition"
    >
      <div className="relative aspect-video overflow-hidden bg-gradient-to-br from-hot/50 via-violet/30 to-cool/30 flex items-center justify-center">
        <span className="text-5xl text-ink-hi" style={{ textShadow: '0 0 16px var(--color-hot)' }}>
          ♥
        </span>
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage:
              'repeating-linear-gradient(to bottom, transparent 0px, transparent 2px, rgba(0,0,0,0.25) 2px, rgba(0,0,0,0.25) 3px)',
          }}
        />
      </div>
      <div className="p-3 flex-1">
        <div className="font-sans text-sm font-semibold text-ink-hi">Liked Songs</div>
        <div className="font-pixel text-sm text-ink-mid uppercase tracking-widest mt-1">
          {count} track{count === 1 ? '' : 's'}
        </div>
      </div>
    </Link>
  )
}

type Tab = 'mine' | 'public'

export default function PlaylistsPage() {
  const jobsQuery = useJobs()
  const activeCount = countActive(jobsQuery.data)
  const [tab, setTab] = useState<Tab>('mine')
  const [creating, setCreating] = useState(false)

  const playlistsQuery = useQuery({
    queryKey: ['playlists', tab === 'mine' ? 'mine' : 'all'],
    queryFn: () => api.playlists(tab === 'mine' ? { owner: 'me' } : {}),
    staleTime: 5_000,
  })
  const libraryQuery = useQuery({
    queryKey: ['library'],
    queryFn: () => api.library(500),
    enabled: tab === 'mine',
    staleTime: 10_000,
  })
  const likedCount = libraryQuery.data?.items.length ?? 0

  // Splitting at render-time keeps a single query in cache covering both tabs
  // (the "all" call includes mine + public).
  const items = playlistsQuery.data?.items ?? []
  const visible = tab === 'mine' ? items.filter((p) => p.is_owner) : items

  return (
    <div className="relative z-10 min-h-full">
      <main className="max-w-6xl mx-auto px-3 sm:px-6 py-4 sm:py-8 pb-32">
        <AppHeader queueCount={activeCount} />

        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div className="font-pixel text-sm text-ink-mid uppercase tracking-[0.2em]">
            ░▒▓ playlists ▓▒░
          </div>
          <div className="flex items-center gap-2">
            <TabButton active={tab === 'mine'} onClick={() => setTab('mine')}>
              ◌ mine
            </TabButton>
            <TabButton active={tab === 'public'} onClick={() => setTab('public')}>
              ◉ public
            </TabButton>
            <ImportButton />
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="font-pixel text-xs uppercase tracking-widest px-3 py-1 border border-hot bg-hot/15 text-ink-hi shadow-[var(--shadow-glow-hot)] hover:bg-hot/25 transition rounded-xs"
            >
              + new
            </button>
          </div>
        </div>

        {creating && <CreatePlaylistDialog onClose={() => setCreating(false)} />}

        {playlistsQuery.isLoading && (
          <div className="font-pixel text-ink-mid">··· loading playlists ···</div>
        )}
        {playlistsQuery.isError && (
          <div className="font-pixel text-crit">
            failed to load playlists:{' '}
            {playlistsQuery.error instanceof Error ? playlistsQuery.error.message : 'unknown'}
          </div>
        )}

        {tab === 'public' && playlistsQuery.data && visible.length === 0 && (
          <div className="card-vapor rounded-sm p-8 text-center">
            <div className="font-pixel text-lg text-ink-mid mb-2">
              ⊹ no playlists ⊹
            </div>
            <div className="font-pixel text-sm text-ink-lo">
              nobody has published a public playlist yet.
            </div>
          </div>
        )}

        {(tab === 'mine' || visible.length > 0) && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {tab === 'mine' && <LikedSongsCard count={likedCount} />}
            {visible.map((p) => (
              <PlaylistCard key={p.id} playlist={p} />
            ))}
          </div>
        )}

        {tab === 'mine' && playlistsQuery.data && visible.length === 0 && (
          <div className="font-pixel text-sm text-ink-lo mt-4 text-center">
            create a playlist above to start curating tracks.
          </div>
        )}
      </main>
    </div>
  )
}

/** Import a playlist from a JSON file (exported elsewhere): create it, then add
 * each track. Tracks already in the shared catalog link instantly; ones not in
 * the catalog are reported as skipped (they'd need a real download first). */
function ImportButton() {
  const qc = useQueryClient()
  const showToast = useToast()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  async function onFile(file: File) {
    setBusy(true)
    try {
      const data = JSON.parse(await file.text())
      const name = String(data?.name || file.name.replace(/\.json$/i, '') || 'Imported playlist').slice(0, 100)
      const tracks: Array<{ video_id?: string; codec?: string; bitrate?: string }> =
        Array.isArray(data?.tracks) ? data.tracks : []
      const { id } = await api.createPlaylist({
        name,
        description: typeof data?.description === 'string' ? data.description : null,
        visibility: 'private',
      })
      const results = await Promise.allSettled(
        tracks.map((t) =>
          t?.video_id && t?.codec && t?.bitrate
            ? api.addToPlaylist(id, { video_id: t.video_id, codec: t.codec, bitrate: t.bitrate })
            : Promise.reject(new Error('bad track')),
        ),
      )
      const added = results.filter((r) => r.status === 'fulfilled').length
      const missing = results.length - added
      qc.invalidateQueries({ queryKey: ['playlists'] })
      showToast({
        message: `imported "${name}" — ${added} added${missing ? `, ${missing} not in catalog yet` : ''}`,
        variant: missing ? 'info' : 'success',
      })
    } catch {
      showToast({ message: 'import failed — invalid playlist file', variant: 'err' })
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void onFile(f)
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        title="import a playlist from a JSON file"
        className="font-pixel text-xs uppercase tracking-widest px-3 py-1 border border-border text-ink-lo hover:text-cool hover:border-cool/70 disabled:opacity-50 transition rounded-xs"
      >
        {busy ? '··· importing' : '⬆ import'}
      </button>
    </>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`font-pixel text-xs uppercase tracking-widest px-2 py-1 border rounded-xs transition ${
        active
          ? 'border-cool text-cool bg-cool/10 shadow-[var(--shadow-glow-cool)]'
          : 'border-border text-ink-lo hover:text-cool hover:border-cool/70'
      }`}
    >
      {children}
    </button>
  )
}

function PlaylistCard({ playlist }: { playlist: PlaylistSummary }) {
  return (
    <Link
      to={`/playlists/${playlist.id}`}
      className="card-vapor rounded-sm overflow-hidden flex flex-col group hover:border-cool/60 transition"
    >
      <div className="relative aspect-video overflow-hidden bg-page-mid img-chromatic">
        {playlist.cover_url ? (
          <img
            src={playlist.cover_url}
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
        <div className="absolute top-1 right-1 font-pixel text-[10px] uppercase tracking-widest px-1.5 py-0.5 bg-page/80 text-cool rounded-xs">
          {playlist.visibility === 'public' ? '◉ public' : '◌ private'}
        </div>
      </div>
      <div className="p-3 flex-1">
        <div className="font-sans text-sm font-semibold text-ink-hi line-clamp-2 leading-snug">
          {playlist.name}
        </div>
        <div className="font-pixel text-sm text-ink-mid uppercase tracking-widest mt-1">
          {playlist.track_count} track{playlist.track_count === 1 ? '' : 's'}
        </div>
      </div>
    </Link>
  )
}

function CreatePlaylistDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [visibility, setVisibility] = useState<PlaylistVisibility>('private')
  const [description, setDescription] = useState('')
  const qc = useQueryClient()

  const create = useMutation({
    mutationFn: () =>
      api.createPlaylist({
        name: name.trim(),
        description: description.trim() || null,
        visibility,
      }),
    onSuccess: () => {
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
          if (name.trim() && !create.isPending) create.mutate()
        }}
        className="card-vapor rounded-sm p-5 w-full max-w-md mx-4 shadow-[var(--shadow-glow-cool)]"
      >
        <div className="font-pixel text-xs uppercase tracking-[0.2em] text-cool mb-4">
          ░ new playlist ░
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
            description (optional)
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
            disabled={!name.trim() || create.isPending}
            className="font-pixel text-sm uppercase tracking-widest px-3 py-1 border border-hot bg-hot/15 text-ink-hi shadow-[var(--shadow-glow-hot)] hover:bg-hot/25 disabled:opacity-30 transition rounded-xs"
          >
            create
          </button>
        </div>
      </form>
    </div>
  )
}
