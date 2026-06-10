import { useState } from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { AppHeader } from '@/shared/ui/AppHeader'
import { ConfirmButton } from '@/shared/ui/ConfirmButton'
import { api } from '@/shared/api/client'
import { countActive, useJobs } from '@/shared/api/useJobs'
import { fmtDuration } from '@/pages/CatalogPage'
import type {
  AdminOverview,
  AdminTrack,
  AdminTrackSort,
  AdminUser,
  AdminSystem,
  JobRow,
} from '@/shared/api/types'

// ── helpers ──────────────────────────────────────────────────────────────────

/** Humanize a byte count into B / KB / MB / GB. Null → em-dash. */
function fmtBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = bytes / 1024
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`
}

/** Compact ISO-ish timestamps to a stable, sortable display string. */
function fmtWhen(ts: string | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  return d.toLocaleString(undefined, {
    year: '2-digit',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

type AdminTab = 'overview' | 'users' | 'jobs' | 'storage' | 'system'

const TABS: { id: AdminTab; icon: string; label: string }[] = [
  { id: 'overview', icon: '◈', label: 'overview' },
  { id: 'users', icon: '⊕', label: 'users' },
  { id: 'jobs', icon: '≣', label: 'jobs' },
  { id: 'storage', icon: '▤', label: 'storage' },
  { id: 'system', icon: '◉', label: 'system' },
]

export default function AdminPage() {
  const jobsQuery = useJobs()
  const activeCount = countActive(jobsQuery.data)
  const [tab, setTab] = useState<AdminTab>('overview')

  return (
    <div className="relative z-10 min-h-full">
      <main className="max-w-6xl mx-auto px-3 sm:px-6 py-4 sm:py-8 pb-32">
        <AppHeader queueCount={activeCount} />

        <div className="font-pixel text-xs text-ink-lo uppercase tracking-[0.2em] mb-6">
          ░▒▓ admin console ▓▒░
        </div>

        {/* Sub-view tab bar — styled exactly like NavTabs. */}
        <nav className="flex items-center gap-1 md:gap-2 flex-wrap mb-6">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-label={t.label}
              title={t.label}
              className={`font-pixel text-base md:text-lg uppercase tracking-widest px-2 md:px-3 py-1 rounded-xs border transition flex items-center gap-2 ${
                tab === t.id
                  ? 'border-hot text-ink-hi bg-hot/10 shadow-[var(--shadow-glow-hot)]'
                  : 'border-border text-ink-mid hover:text-cool hover:border-cool/70'
              }`}
            >
              <span>{t.icon}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </nav>

        {tab === 'overview' && <OverviewView />}
        {tab === 'users' && <UsersView />}
        {tab === 'jobs' && <JobsView />}
        {tab === 'storage' && <StorageView />}
        {tab === 'system' && <SystemView />}
      </main>
    </div>
  )
}

// ── shared shells ────────────────────────────────────────────────────────────

function Loading({ what }: { what: string }) {
  return <div className="font-pixel text-ink-mid">··· loading {what} ···</div>
}

function ErrorLine({ error }: { error: unknown }) {
  return (
    <div className="font-pixel text-crit">
      ⚠ failed to load:{' '}
      {error instanceof Error ? error.message : 'unknown error'}
    </div>
  )
}

function TableHeader({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2 font-pixel text-[10px] sm:text-xs uppercase tracking-widest text-ink-lo bg-page-mid/40">
      {children}
    </li>
  )
}

// ── Overview ─────────────────────────────────────────────────────────────────

function StatCard({
  glyph,
  label,
  value,
  accent,
}: {
  glyph: string
  label: string
  value: string
  accent: 'hot' | 'cool' | 'violet'
}) {
  const accentText =
    accent === 'hot'
      ? 'text-hot'
      : accent === 'cool'
        ? 'text-cool'
        : 'text-violet'
  return (
    <div className="card-vapor rounded-sm p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2 font-pixel text-xs uppercase tracking-widest text-ink-lo">
        <span className={accentText}>{glyph}</span>
        <span>{label}</span>
      </div>
      <div
        className={`font-pixel text-2xl sm:text-3xl tabular-nums ${accentText}`}
        style={{ textShadow: '0 0 8px currentColor' }}
      >
        {value}
      </div>
    </div>
  )
}

function OverviewView() {
  const q = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => api.adminOverview(),
    staleTime: 10_000,
  })

  if (q.isLoading) return <Loading what="overview" />
  if (q.isError) return <ErrorLine error={q.error} />
  const o = q.data as AdminOverview

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-6">
        <StatCard glyph="⊕" label="users" value={o.users.toLocaleString()} accent="cool" />
        <StatCard glyph="▤" label="tracks" value={o.tracks.toLocaleString()} accent="hot" />
        <StatCard glyph="◈" label="storage" value={fmtBytes(o.storage_bytes)} accent="violet" />
        <StatCard glyph="▶" label="plays" value={o.plays.toLocaleString()} accent="cool" />
        <StatCard glyph="≣" label="playlists" value={o.playlists.toLocaleString()} accent="violet" />
        <StatCard glyph="↺" label="active jobs" value={o.active_jobs.toLocaleString()} accent="hot" />
      </div>

      <div className="card-vapor rounded-sm p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="flex items-center justify-between gap-3">
          <span className="font-pixel text-xs uppercase tracking-widest text-ink-lo">
            ◉ schema version
          </span>
          <span className="font-sans text-sm text-ink-hi tabular-nums">
            {o.schema_version}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="font-pixel text-xs uppercase tracking-widest text-ink-lo">
            ◉ yt-dlp
          </span>
          <span className="font-sans text-sm text-ink-hi tabular-nums">
            {o.yt_dlp_version}
          </span>
        </div>
      </div>
    </>
  )
}

// ── Users ────────────────────────────────────────────────────────────────────

function UsersView() {
  const q = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api.adminUsers(),
    staleTime: 10_000,
  })

  if (q.isLoading) return <Loading what="users" />
  if (q.isError) return <ErrorLine error={q.error} />
  const users = q.data?.users ?? []

  if (users.length === 0) {
    return (
      <div className="card-vapor rounded-sm p-8 text-center font-pixel text-ink-lo">
        ⊹ no users have signed in yet ⊹
      </div>
    )
  }

  return (
    <ul className="card-vapor rounded-sm divide-y divide-border">
      <TableHeader>
        <span className="flex-1 min-w-0">user</span>
        <span className="w-16 text-right">role</span>
        <span className="w-16 sm:w-20 text-right">library</span>
        <span className="w-14 sm:w-16 text-right">plays</span>
        <span className="hidden sm:block w-32 text-right">last seen</span>
      </TableHeader>
      {users.map((u: AdminUser) => (
        <li
          key={u.user_id}
          className="flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2"
        >
          <div className="flex-1 min-w-0">
            <div className="font-sans text-sm font-medium text-ink-hi truncate">
              {u.username || u.user_id}
            </div>
            <div className="font-pixel text-[10px] text-ink-lo truncate">
              {u.user_id}
            </div>
          </div>
          <span className="w-16 text-right">
            <span
              className={`font-pixel text-[10px] uppercase tracking-widest px-1.5 py-px border rounded-xs ${
                u.role === 'ADMIN'
                  ? 'border-hot/60 text-hot'
                  : 'border-border text-ink-mid'
              }`}
            >
              {u.role}
            </span>
          </span>
          <span className="w-16 sm:w-20 text-right font-sans text-sm text-cool tabular-nums">
            {u.library_count}
          </span>
          <span className="w-14 sm:w-16 text-right font-sans text-sm text-violet tabular-nums">
            {u.play_count}
          </span>
          <span className="hidden sm:block w-32 text-right font-sans text-xs text-ink-lo tabular-nums">
            {fmtWhen(u.last_seen_at)}
          </span>
        </li>
      ))}
    </ul>
  )
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

const JOB_STATUS_COLOR: Record<string, string> = {
  queued: 'text-ink-mid',
  downloading: 'text-cool',
  merging: 'text-cool',
  transcoding: 'text-cool',
  done: 'text-violet',
  error: 'text-crit',
  interrupted: 'text-crit',
  cancelled: 'text-ink-lo',
}

function JobsView() {
  const queryClient = useQueryClient()
  const q = useQuery({
    queryKey: ['admin', 'jobs', { status: undefined }],
    queryFn: () => api.adminJobs({ limit: 200 }),
    refetchInterval: 5_000,
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['admin', 'jobs'] })
    queryClient.invalidateQueries({ queryKey: ['admin', 'overview'] })
  }

  const cancel = useMutation({
    mutationFn: (id: string) => api.cancel(id),
    onSuccess: invalidate,
  })
  const retry = useMutation({
    mutationFn: (id: string) => api.retry(id),
    onSuccess: invalidate,
  })
  const del = useMutation({
    mutationFn: (id: string) => api.delete(id),
    onSuccess: invalidate,
  })

  if (q.isLoading) return <Loading what="jobs" />
  if (q.isError) return <ErrorLine error={q.error} />
  const jobs = q.data?.jobs ?? []

  if (jobs.length === 0) {
    return (
      <div className="card-vapor rounded-sm p-8 text-center font-pixel text-ink-lo">
        ⊹ the queue is empty ⊹
      </div>
    )
  }

  return (
    <ul className="card-vapor rounded-sm divide-y divide-border">
      <TableHeader>
        <span className="flex-1 min-w-0">job</span>
        <span className="w-24 text-right">status</span>
        <span className="w-14 text-right">pct</span>
        <span className="w-[8.5rem] text-right">actions</span>
      </TableHeader>
      {jobs.map((j: JobRow) => (
        <JobRowItem
          key={j.id}
          job={j}
          onCancel={() => cancel.mutate(j.id)}
          onRetry={() => retry.mutate(j.id)}
          onDelete={() => del.mutate(j.id)}
          busy={cancel.isPending || retry.isPending || del.isPending}
        />
      ))}
    </ul>
  )
}

function JobRowItem({
  job,
  onCancel,
  onRetry,
  onDelete,
  busy,
}: {
  job: JobRow
  onCancel: () => void
  onRetry: () => void
  onDelete: () => void
  busy: boolean
}) {
  const isActive = ['queued', 'downloading', 'merging', 'transcoding'].includes(
    job.status,
  )
  const isFailed = ['error', 'interrupted', 'cancelled'].includes(job.status)
  const isPlaylist = Boolean(job.is_playlist)

  return (
    <li className="flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2">
      <div className="flex-1 min-w-0">
        <div className="font-sans text-sm text-ink-hi truncate">
          {isPlaylist ? '≣ ' : ''}
          {job.title ?? job.playlist_title ?? job.url}
        </div>
        <div className="font-pixel text-[10px] text-ink-lo truncate">
          {job.uploader ?? '—'}
          {job.owner_id ? <span> · {job.owner_id}</span> : null}
          {job.error_message ? (
            <span className="text-crit"> · {job.error_message}</span>
          ) : null}
        </div>
      </div>

      <span
        className={`w-24 text-right font-pixel text-[10px] uppercase tracking-widest ${
          JOB_STATUS_COLOR[job.status] ?? 'text-ink-mid'
        }`}
      >
        {job.status}
      </span>

      <span className="w-14 text-right font-sans text-sm text-ink-mid tabular-nums">
        {job.progress_pct != null ? `${Math.round(job.progress_pct)}%` : '—'}
      </span>

      <div className="w-[8.5rem] flex items-center justify-end gap-1">
        {isActive && (
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            title="cancel job"
            className="font-pixel text-xs px-2 py-1 border border-border text-ink-lo hover:text-crit hover:border-crit/60 transition rounded-xs disabled:opacity-40"
          >
            ✕
          </button>
        )}
        {isFailed && (
          <button
            type="button"
            onClick={onRetry}
            disabled={busy}
            title="retry job"
            className="font-pixel text-xs px-2 py-1 border border-cool/60 text-cool hover:bg-cool/10 transition rounded-xs disabled:opacity-40"
          >
            ↺
          </button>
        )}
        <ConfirmButton
          onConfirm={onDelete}
          disabled={busy}
          idle="✕ del"
          title="delete job from the queue"
        />
      </div>
    </li>
  )
}

// ── Storage ──────────────────────────────────────────────────────────────────

const TRACK_SORTS: { id: AdminTrackSort; label: string }[] = [
  { id: 'largest', label: 'largest' },
  { id: 'smallest', label: 'smallest' },
  { id: 'newest', label: 'newest' },
  { id: 'oldest', label: 'oldest' },
  { id: 'popular', label: 'popular' },
]

function StorageView() {
  const queryClient = useQueryClient()
  const [orphansOnly, setOrphansOnly] = useState(false)
  const [sort, setSort] = useState<AdminTrackSort>('largest')

  const q = useQuery({
    queryKey: ['admin', 'tracks', { orphans_only: orphansOnly, sort }],
    queryFn: () => api.adminTracks({ orphans_only: orphansOnly, sort, limit: 200 }),
    staleTime: 10_000,
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['admin', 'tracks'] })
    queryClient.invalidateQueries({ queryKey: ['admin', 'overview'] })
  }

  const delTrack = useMutation({
    mutationFn: (args: {
      videoId: string
      codec: string
      bitrate: string
      force: boolean
    }) =>
      api.adminDeleteTrack(args.videoId, args.codec, args.bitrate, {
        force: args.force,
      }),
    onSuccess: invalidate,
  })

  const cleanup = useMutation({
    mutationFn: () => api.adminCleanupOrphans(),
    onSuccess: invalidate,
  })

  const tracks = q.data?.tracks ?? []

  return (
    <>
      <div className="mb-3 flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => setOrphansOnly((o) => !o)}
          title="show only tracks no user owns"
          className={`font-pixel text-xs uppercase tracking-widest px-3 py-1 border rounded-xs transition ${
            orphansOnly
              ? 'border-crit/60 text-crit bg-crit/10'
              : 'border-border text-ink-lo hover:text-cool hover:border-cool/70'
          }`}
        >
          ⚠ orphans only
        </button>

        {TRACK_SORTS.map((s) => (
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

        <span className="flex-1" />

        <CleanOrphansButton
          onConfirm={() => cleanup.mutate()}
          pending={cleanup.isPending}
          result={cleanup.data ?? null}
        />
      </div>

      {q.isLoading ? (
        <Loading what="storage" />
      ) : q.isError ? (
        <ErrorLine error={q.error} />
      ) : tracks.length === 0 ? (
        <div className="card-vapor rounded-sm p-8 text-center font-pixel text-ink-lo">
          {orphansOnly
            ? '⊹ no orphan tracks — every master is owned ⊹'
            : '⊹ no tracks on disk ⊹'}
        </div>
      ) : (
        <ul className="card-vapor rounded-sm divide-y divide-border">
          <TableHeader>
            <span className="flex-1 min-w-0">track</span>
            <span className="w-16 sm:w-20 text-right">codec</span>
            <span className="w-14 text-right">owners</span>
            <span className="w-16 sm:w-20 text-right">size</span>
            <span className="w-[5.5rem] text-right">action</span>
          </TableHeader>
          {tracks.map((t: AdminTrack) => (
            <StorageRow
              key={`${t.video_id}/${t.codec}/${t.bitrate}`}
              track={t}
              onDelete={(force) =>
                delTrack.mutate({
                  videoId: t.video_id,
                  codec: t.codec,
                  bitrate: t.bitrate,
                  force,
                })
              }
              busy={delTrack.isPending}
            />
          ))}
        </ul>
      )}
    </>
  )
}

function StorageRow({
  track,
  onDelete,
  busy,
}: {
  track: AdminTrack
  onDelete: (force: boolean) => void
  busy: boolean
}) {
  const isOrphan = track.owner_count === 0
  // Owned tracks need force=true to delete; orphans don't.
  const force = !isOrphan
  return (
    <li className="flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2">
      <div className="flex-1 min-w-0">
        <div className="font-sans text-sm text-ink-hi truncate">
          {track.title ?? track.video_id}
        </div>
        <div className="font-pixel text-[10px] text-ink-lo truncate flex items-center gap-2 flex-wrap">
          <span>{track.artist ?? '—'}</span>
          {track.duration_sec != null && (
            <span className="text-cool tabular-nums">
              {fmtDuration(track.duration_sec)}
            </span>
          )}
          {isOrphan && (
            <span className="text-crit uppercase tracking-widest">⚠ orphan</span>
          )}
          {!track.file_exists && (
            <span className="text-crit uppercase tracking-widest">⚠ missing</span>
          )}
        </div>
      </div>

      <span className="w-16 sm:w-20 text-right font-sans text-xs text-ink-mid truncate">
        {track.codec}·{track.bitrate}
      </span>

      <span
        className={`w-14 text-right font-sans text-sm tabular-nums ${
          isOrphan ? 'text-crit' : 'text-violet'
        }`}
      >
        {track.owner_count}
      </span>

      <span className="w-16 sm:w-20 text-right font-sans text-sm text-cool tabular-nums">
        {fmtBytes(track.file_size)}
      </span>

      <div className="w-[5.5rem] flex items-center justify-end">
        <ConfirmButton
          onConfirm={() => onDelete(force)}
          disabled={busy}
          idle="✕ del"
          title={
            force
              ? 'force-delete an owned track + its file'
              : 'delete this orphan track + its file'
          }
        />
      </div>
    </li>
  )
}

function CleanOrphansButton({
  onConfirm,
  pending,
  result,
}: {
  onConfirm: () => void
  pending: boolean
  result: { deleted: number; bytes_reclaimed: number } | null
}) {
  const [armed, setArmed] = useState(false)

  if (result && !armed) {
    return (
      <span className="font-pixel text-xs uppercase tracking-widest text-violet">
        ✓ removed {result.deleted} · freed {fmtBytes(result.bytes_reclaimed)}
      </span>
    )
  }

  if (armed) {
    return (
      <span className="flex items-center gap-1">
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            onConfirm()
            setArmed(false)
          }}
          className="font-pixel text-xs uppercase tracking-widest px-2 py-1 border border-crit/60 text-crit bg-crit/10 hover:bg-crit/20 transition rounded-xs disabled:opacity-40"
        >
          ⚠ confirm
        </button>
        <button
          type="button"
          onClick={() => setArmed(false)}
          className="font-pixel text-xs uppercase tracking-widest px-2 py-1 border border-border text-ink-lo hover:text-cool transition rounded-xs"
        >
          ✕ cancel
        </button>
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setArmed(true)}
      disabled={pending}
      title="delete every orphan master track + its file on disk"
      className="font-pixel text-xs uppercase tracking-widest px-3 py-1 border border-crit/60 text-crit hover:bg-crit/10 transition rounded-xs disabled:opacity-40"
    >
      {pending ? '··· cleaning' : '⚠ clean orphans'}
    </button>
  )
}

// ── System ───────────────────────────────────────────────────────────────────

function SystemView() {
  const q = useQuery({
    queryKey: ['admin', 'system'],
    queryFn: () => api.adminSystem(),
    staleTime: 10_000,
  })

  if (q.isLoading) return <Loading what="system" />
  if (q.isError) return <ErrorLine error={q.error} />
  const s = q.data as AdminSystem

  const libUsedPct =
    s.library.total_bytes > 0
      ? Math.min(100, (s.library.used_bytes / s.library.total_bytes) * 100)
      : 0

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      {/* yt-dlp + extraction */}
      <div className="card-vapor rounded-sm p-4">
        <SystemHeading glyph="◉" label="extraction" />
        <SystemRow label="yt-dlp" value={s.yt_dlp_version} />
        <SystemRow
          label="probe"
          valueNode={
            s.extraction.ok === null ? (
              <span className="text-ink-lo">— not checked</span>
            ) : s.extraction.ok ? (
              <span className="text-violet">✦ ok</span>
            ) : (
              <span className="text-crit">⚠ failing</span>
            )
          }
        />
        {s.extraction.error && (
          <div className="mt-1 font-sans text-xs text-crit break-words">
            {s.extraction.error}
          </div>
        )}
        <SystemRow label="checked" value={fmtWhen(new Date(s.extraction.checked_at * 1000).toISOString())} />
      </div>

      {/* cookies */}
      <div className="card-vapor rounded-sm p-4">
        <SystemHeading glyph="◈" label="cookies" />
        <SystemRow
          label="configured"
          valueNode={
            s.cookies.configured ? (
              <span className="text-violet">✦ yes</span>
            ) : (
              <span className="text-crit">⚠ no</span>
            )
          }
        />
        <SystemRow label="source" value={s.cookies.source} />
        {s.cookies.expiry && (
          <SystemRow label="expiry" valueNode={<CookieExpiry expiry={s.cookies.expiry} />} />
        )}
        {s.cookies.error && (
          <div className="mt-1 font-sans text-xs text-crit break-words">
            {s.cookies.error}
          </div>
        )}
      </div>

      {/* db */}
      <div className="card-vapor rounded-sm p-4">
        <SystemHeading glyph="▤" label="database" />
        <SystemRow label="size" value={fmtBytes(s.db.size_bytes)} />
        <div className="mt-1 font-sans text-xs text-ink-lo break-all">
          {s.db.path}
        </div>
      </div>

      {/* library disk */}
      <div className="card-vapor rounded-sm p-4">
        <SystemHeading glyph="≣" label="library disk" />
        <SystemRow label="used" value={fmtBytes(s.library.used_bytes)} />
        <SystemRow label="free" value={fmtBytes(s.library.free_bytes)} />
        <SystemRow label="total" value={fmtBytes(s.library.total_bytes)} />
        <div className="mt-2 h-2 rounded-xs overflow-hidden border border-border bg-page-mid">
          <div
            className="h-full bg-gradient-to-r from-cool via-violet to-hot"
            style={{ width: `${libUsedPct}%` }}
          />
        </div>
        <div className="mt-1 font-sans text-xs text-ink-lo break-all">
          {s.library.path}
        </div>
      </div>
    </div>
  )
}

/** Cookie expiry status: crit if any expired / already negative, sun under 14
 * days (advance warning), cool otherwise. Turns the worst silent prod failure
 * (lapsed YouTube cookies → extraction starts 503ing) into an early signal. */
function CookieExpiry({
  expiry,
}: {
  expiry: NonNullable<AdminSystem['cookies']['expiry']>
}) {
  const days = expiry.days_remaining
  if (expiry.expired_count > 0 || (days != null && days < 0)) {
    return (
      <span className="text-crit">
        ⚠ {expiry.expired_count > 0 ? `${expiry.expired_count} expired` : 'expired'}
      </span>
    )
  }
  if (days == null) return <span className="text-ink-lo">— session only</span>
  const cls = days < 14 ? 'text-sun' : 'text-cool'
  return (
    <span className={cls}>
      {days < 14 ? '⚠ ' : ''}
      {days}d left
    </span>
  )
}

function SystemHeading({ glyph, label }: { glyph: string; label: string }) {
  return (
    <div className="flex items-center gap-2 font-pixel text-xs uppercase tracking-widest text-cool mb-3">
      <span>{glyph}</span>
      <span>{label}</span>
      <span className="flex-1 border-t border-border" />
    </div>
  )
}

function SystemRow({
  label,
  value,
  valueNode,
}: {
  label: string
  value?: string
  valueNode?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="font-pixel text-[10px] uppercase tracking-widest text-ink-lo">
        {label}
      </span>
      <span className="font-sans text-sm text-ink-hi tabular-nums truncate">
        {valueNode ?? value}
      </span>
    </div>
  )
}

