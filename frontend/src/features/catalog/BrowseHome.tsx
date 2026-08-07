import type {
  ActivityItem,
  ArtistStat,
  CatalogItem,
  Category,
  DailyMix,
} from '@/shared/api/types'
import { SectionHeader } from '@/shared/ui/SectionHeader'
import { RefreshButton } from '@/shared/ui/RefreshButton'
import { ActivityRow, CategoryCard, DailyMixCard, RecentCard } from './cards'

/** The browse "home" shown when idle on the full catalog. */
export function BrowseHome({
  recent,
  topTracks,
  topArtists,
  activity,
  mixes,
  mixesLoading,
  mixesRefreshing,
  onRefreshMixes,
  personalized,
  categories,
  onOpenCategory,
  onOpenMix,
}: {
  recent: CatalogItem[]
  topTracks: CatalogItem[]
  topArtists: ArtistStat[]
  activity: ActivityItem[]
  mixes: DailyMix[]
  mixesLoading: boolean
  mixesRefreshing: boolean
  onRefreshMixes: () => void
  personalized: boolean
  categories: Category[]
  onOpenCategory: (c: Category) => void
  onOpenMix: (m: DailyMix) => void
}) {
  return (
    <>
      {recent.length > 0 && (
        <section className="mb-8">
          <SectionHeader title="↺ recently played" />
          <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 snap-x">
            {recent.map((it, i) => (
              <RecentCard
                key={`${it.video_id}/${it.codec}/${it.bitrate}`}
                item={it}
                queue={recent}
                index={i}
              />
            ))}
          </div>
        </section>
      )}

      {topTracks.length > 0 && (
        <section className="mb-8">
          <SectionHeader title="★ your top" note="last 30 days" />
          {topArtists.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {topArtists.map((a) => (
                <span
                  key={a.artist}
                  className="font-pixel text-xs uppercase tracking-widest px-2 py-1 border border-cool/50 text-cool rounded-xs"
                >
                  {a.artist} <span className="text-ink-lo tabular-nums">·{a.play_count}</span>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 snap-x">
            {topTracks.map((it, i) => (
              <RecentCard
                key={`${it.video_id}/${it.codec}/${it.bitrate}`}
                item={it}
                queue={topTracks}
                index={i}
              />
            ))}
          </div>
        </section>
      )}

      {(mixesLoading || mixes.length > 0) && (
        <section className="mb-8">
          <SectionHeader
            title="◈ daily mixes"
            note={personalized ? 'tuned to what you play' : 'fresh every day'}
            action={
              mixes.length > 0 ? (
                <RefreshButton
                  onClick={onRefreshMixes}
                  busy={mixesRefreshing}
                  title="re-roll your daily mixes"
                />
              ) : undefined
            }
          />
          <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 snap-x">
            {mixesLoading && mixes.length === 0
              ? Array.from({ length: 3 }).map((_, i) => (
                  <div
                    key={i}
                    className="w-40 sm:w-44 flex-shrink-0 card-vapor rounded-sm overflow-hidden border border-border animate-pulse"
                  >
                    <div className="aspect-square bg-violet/10" />
                    <div className="p-2 space-y-2">
                      <div className="h-3 bg-violet/10 rounded-xs" />
                      <div className="h-3 w-1/2 bg-violet/10 rounded-xs" />
                    </div>
                  </div>
                ))
              : mixes.map((m) => (
                  <DailyMixCard key={m.id} mix={m} onOpen={() => onOpenMix(m)} />
                ))}
          </div>
        </section>
      )}

      {categories.length > 0 && (
        <section className="mb-8">
          <SectionHeader title="▦ browse" />
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {categories.map((c) => (
              <CategoryCard key={c.slug} category={c} onClick={() => onOpenCategory(c)} />
            ))}
          </div>
        </section>
      )}

      {activity.length > 0 && (
        <section className="mb-8">
          <SectionHeader title="⊹ recent activity" note="what the crew added" />
          <ul className="card-vapor rounded-sm divide-y divide-border">
            {activity.map((it, i) => (
              <ActivityRow
                key={`${it.video_id}/${it.added_at}/${i}`}
                item={it}
                queue={activity}
                index={i}
              />
            ))}
          </ul>
        </section>
      )}
    </>
  )
}
