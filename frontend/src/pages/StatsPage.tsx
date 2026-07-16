import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { AppHeader } from '@/shared/ui/AppHeader'
import { EmptyState } from '@/shared/ui/EmptyState'
import { Thumb } from '@/shared/ui/Thumb'
import { api } from '@/shared/api/client'
import type { CatalogItem } from '@/shared/api/types'
import { countActive, useJobs } from '@/shared/api/useJobs'
import { catalogToLibrary as toLibraryItem } from '@/shared/lib/libraryItem'
import { SectionHeader } from '@/shared/ui/SectionHeader'
import { useAudioPlayer } from '@/features/player/AudioPlayerProvider'

/** Listening "Wrapped" — total plays + top artists/tracks over a chosen window.
 * Pure read of /api/me/stats, which already supports any window incl. all-time
 * (window_days = 0). */
const WINDOWS: { label: string; days: number }[] = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '1y', days: 365 },
  { label: 'all', days: 0 },
]

export default function StatsPage() {
  const jobsQuery = useJobs()
  const activeCount = countActive(jobsQuery.data)
  const player = useAudioPlayer()
  const [days, setDays] = useState(30)

  const q = useQuery({
    queryKey: ['my-stats', days],
    queryFn: () => api.myStats(days),
    staleTime: 60_000,
  })

  const stats = q.data
  const topTracks: CatalogItem[] = stats?.top_tracks ?? []
  const topArtists = stats?.top_artists ?? []
  const hasData = (stats?.total_plays ?? 0) > 0 || topTracks.length > 0

  return (
    <div className="relative z-10 min-h-full">
      <main className="max-w-6xl mx-auto px-3 sm:px-6 py-4 sm:py-8 pb-bottombars">
        <AppHeader queueCount={activeCount} />

        <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
          <div className="font-pixel text-lg uppercase tracking-widest text-hot">
            ★ your stats
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {WINDOWS.map((w) => (
              <button
                key={w.days}
                type="button"
                onClick={() => setDays(w.days)}
                className={`font-pixel text-xs uppercase tracking-widest px-2 py-1 border rounded-xs transition ${
                  days === w.days
                    ? 'border-cool text-cool bg-cool/10 shadow-[var(--shadow-glow-cool)]'
                    : 'border-border text-ink-lo hover:text-cool hover:border-cool/70'
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>

        {q.isLoading && (
          <div className="font-pixel text-ink-mid">··· crunching your stats ···</div>
        )}
        {q.isError && (
          <div className="font-pixel text-crit">
            ⚠ failed to load stats:{' '}
            {q.error instanceof Error ? q.error.message : 'unknown'}
          </div>
        )}

        {stats && !hasData && (
          <EmptyState
            glyph="★"
            title="no plays yet"
            hint="listen to a few tracks (~20s each) and your stats will build here."
            cta={{ to: '/catalog', label: '⊕ browse the catalog' }}
          />
        )}

        {stats && hasData && (
          <>
            {/* big total */}
            <div className="card-vapor rounded-sm p-6 mb-6 flex flex-col items-center">
              <div className="font-pixel text-xs uppercase tracking-[0.2em] text-ink-lo mb-1">
                ▶ total plays
              </div>
              <div
                className="font-pixel text-5xl sm:text-6xl tabular-nums text-hot"
                style={{ textShadow: '0 0 14px currentColor' }}
              >
                {stats.total_plays.toLocaleString()}
              </div>
            </div>

            {topArtists.length > 0 && (
              <section className="mb-8">
                <SectionHeader title="◈ top artists" />
                <div className="flex flex-wrap gap-2">
                  {topArtists.map((a, i) => (
                    <span
                      key={a.artist}
                      className="font-pixel text-sm uppercase tracking-widest px-3 py-1.5 border border-cool/50 text-cool rounded-xs"
                    >
                      <span className="text-ink-lo tabular-nums">{i + 1}.</span>{' '}
                      {a.artist}{' '}
                      <span className="text-ink-lo tabular-nums">·{a.play_count}</span>
                    </span>
                  ))}
                </div>
              </section>
            )}

            {topTracks.length > 0 && (
              <section>
                <SectionHeader
                  title="★ top tracks"
                  action={
                    <button
                      type="button"
                      onClick={() => player.play(topTracks.map(toLibraryItem), 0)}
                      className="font-pixel text-xs uppercase tracking-widest px-3 py-1 border border-hot bg-hot/15 text-ink-hi shadow-[var(--shadow-glow-hot)] hover:bg-hot/25 transition rounded-xs"
                    >
                      ▶ play all
                    </button>
                  }
                />
                <ol className="card-vapor rounded-sm divide-y divide-border">
                  {topTracks.map((t, i) => (
                    <li
                      key={`${t.video_id}/${t.codec}/${t.bitrate}`}
                      onClick={() => player.play(topTracks.map(toLibraryItem), i)}
                      className="flex items-center gap-3 px-2 sm:px-3 py-2 cursor-pointer hover:bg-violet/10 transition"
                    >
                      <span className="font-pixel text-sm text-ink-lo w-6 text-right tabular-nums">
                        {i + 1}
                      </span>
                      <Thumb src={t.thumbnail_url} className="w-14 sm:w-20" />
                      <div className="flex-1 min-w-0">
                        <div className="font-sans text-sm font-medium text-ink-hi truncate">
                          {t.title ?? t.video_id}
                        </div>
                        <div className="text-sm text-ink-lo truncate mt-0.5">
                          {t.artist ?? '—'}
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  )
}
