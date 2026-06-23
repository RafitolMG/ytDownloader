import type {
  CatalogItem,
  Category,
  DailyMix,
  ExternalCatalogItem,
} from '@/shared/api/types'
import { catalogToLibrary as toLibraryItem } from '@/shared/lib/libraryItem'
import { useAudioPlayer } from '@/features/player/AudioPlayerProvider'
import { ACCENT } from './lib'
import { CatalogRow, DownloadAllButton, ExternalRow } from './rows'

/** Expanded category feed: playable catalog tracks + downloadable candidates. */
export function CategoryView({
  category,
  feed,
  isLoading,
  onBack,
}: {
  category: Category
  feed: { db: CatalogItem[]; external: ExternalCatalogItem[] } | undefined
  isLoading: boolean
  onBack: () => void
}) {
  const player = useAudioPlayer()
  const db = feed?.db ?? []
  const external = feed?.external ?? []
  return (
    <section>
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <button
          type="button"
          onClick={onBack}
          className="font-pixel text-xs uppercase tracking-widest px-2 py-1 border border-border text-ink-lo hover:text-cool hover:border-cool/70 transition rounded-xs"
        >
          ← back
        </button>
        <h2 className={`font-pixel text-lg uppercase tracking-widest ${ACCENT[category.accent].text}`}>
          {category.title}
        </h2>
        {db.length > 0 && (
          <button
            type="button"
            onClick={() => player.play(db.map(toLibraryItem), 0)}
            className="font-pixel text-xs uppercase tracking-widest px-3 py-1 border border-hot bg-hot/15 text-ink-hi shadow-[var(--shadow-glow-hot)] hover:bg-hot/25 transition rounded-xs"
          >
            ▶ play all
          </button>
        )}
      </div>

      {isLoading && (
        <div className="font-pixel text-ink-mid">
          ··· loading {category.title.toLowerCase()} ···
        </div>
      )}

      {db.length > 0 && (
        <ul className="card-vapor rounded-sm divide-y divide-border mb-2">
          {db.map((it, idx) => (
            <CatalogRow
              key={`${it.video_id}/${it.codec}/${it.bitrate}`}
              item={it}
              position={idx + 1}
              allItems={db}
            />
          ))}
        </ul>
      )}

      {external.length > 0 && (
        <>
          <div className="mt-6 mb-3 flex items-center gap-3 font-pixel text-xs text-ink-lo uppercase tracking-[0.2em]">
            <span>↓ download more {category.title.toLowerCase()}</span>
            <span className="flex-1 border-t border-border" />
            <DownloadAllButton items={external} />
          </div>
          <ul className="card-vapor rounded-sm divide-y divide-border">
            {external.map((ext, idx) => (
              <ExternalRow
                key={ext.video_id}
                item={ext}
                position={db.length + idx + 1}
              />
            ))}
          </ul>
        </>
      )}

      {!isLoading && db.length === 0 && external.length === 0 && (
        <div className="card-vapor rounded-sm p-8 text-center font-pixel text-ink-lo">
          nothing found for this category right now.
        </div>
      )}
    </section>
  )
}

/** Daily-mix preview: the full tracklist with play-all, opened from a mix card. */
export function MixView({ mix, onBack }: { mix: DailyMix; onBack: () => void }) {
  const player = useAudioPlayer()
  const a = ACCENT[mix.accent]
  const cover = mix.tracks[0]?.thumbnail_url ?? null
  return (
    <section>
      <div className="flex items-center gap-4 mb-5 flex-wrap">
        <button
          type="button"
          onClick={onBack}
          className="font-pixel text-xs uppercase tracking-widest px-2 py-1 border border-border text-ink-lo hover:text-cool hover:border-cool/70 transition rounded-xs"
        >
          ← back
        </button>
        <div
          className={`relative w-16 h-16 rounded-sm overflow-hidden border ${a.border} bg-gradient-to-br ${a.grad} flex-shrink-0`}
        >
          {cover && (
            <img
              src={cover}
              alt=""
              className="w-full h-full object-cover opacity-60"
              referrerPolicy="no-referrer"
            />
          )}
        </div>
        <div className="min-w-0">
          <div className={`font-pixel text-lg uppercase tracking-widest ${a.text}`}>
            {mix.title}
          </div>
          <div className="font-sans text-sm text-ink-mid truncate">
            {mix.subtitle} · {mix.tracks.length} tracks
          </div>
        </div>
        {mix.tracks.length > 0 && (
          <button
            type="button"
            onClick={() => player.play(mix.tracks.map(toLibraryItem), 0)}
            className="font-pixel text-xs uppercase tracking-widest px-4 py-2 border border-hot bg-hot/15 text-ink-hi shadow-[var(--shadow-glow-hot)] hover:bg-hot/25 transition rounded-xs"
          >
            ▶ play all
          </button>
        )}
      </div>

      <ul className="card-vapor rounded-sm divide-y divide-border">
        {mix.tracks.map((it, idx) => (
          <CatalogRow
            key={`${it.video_id}/${it.codec}/${it.bitrate}`}
            item={it}
            position={idx + 1}
            allItems={mix.tracks}
          />
        ))}
      </ul>

      {mix.external.length > 0 && (
        <>
          <div className="mt-6 mb-3 flex items-center gap-3 font-pixel text-xs text-ink-lo uppercase tracking-[0.2em]">
            <span>↓ more in this mix · download to play</span>
            <span className="flex-1 border-t border-border" />
            <DownloadAllButton items={mix.external} own={false} />
          </div>
          <ul className="card-vapor rounded-sm divide-y divide-border">
            {mix.external.map((ext, idx) => (
              <ExternalRow
                key={ext.video_id}
                item={ext}
                position={mix.tracks.length + idx + 1}
                own={false}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

/** "More like this" radio from a seed track: what you already have (playable)
 * + new candidates to download. */
export function RadioView({
  seed,
  feed,
  isLoading,
  onBack,
}: {
  seed: CatalogItem
  feed: { db: CatalogItem[]; external: ExternalCatalogItem[] } | undefined
  isLoading: boolean
  onBack: () => void
}) {
  const player = useAudioPlayer()
  const db = feed?.db ?? []
  const external = feed?.external ?? []
  return (
    <section>
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <button
          type="button"
          onClick={onBack}
          className="font-pixel text-xs uppercase tracking-widest px-2 py-1 border border-border text-ink-lo hover:text-cool hover:border-cool/70 transition rounded-xs"
        >
          ← back
        </button>
        <div className="relative w-14 h-14 rounded-sm overflow-hidden border border-cool/50 bg-page-mid flex-shrink-0">
          {seed.thumbnail_url ? (
            <img
              src={seed.thumbnail_url}
              alt=""
              className="w-full h-full object-cover"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-violet/40 via-hot/20 to-cool/30" />
          )}
        </div>
        <div className="min-w-0">
          <div className="font-pixel text-lg uppercase tracking-widest text-cool">
            ≈ radio
          </div>
          <div className="font-sans text-sm text-ink-mid truncate">
            like {seed.title ?? seed.video_id}
          </div>
        </div>
        {db.length > 0 && (
          <button
            type="button"
            onClick={() => player.play(db.map(toLibraryItem), 0)}
            className="font-pixel text-xs uppercase tracking-widest px-4 py-2 border border-hot bg-hot/15 text-ink-hi shadow-[var(--shadow-glow-hot)] hover:bg-hot/25 transition rounded-xs"
          >
            ▶ play all
          </button>
        )}
      </div>

      {isLoading && (
        <div className="font-pixel text-ink-mid">··· tuning the radio ···</div>
      )}

      {db.length > 0 && (
        <ul className="card-vapor rounded-sm divide-y divide-border mb-2">
          {db.map((it, idx) => (
            <CatalogRow
              key={`${it.video_id}/${it.codec}/${it.bitrate}`}
              item={it}
              position={idx + 1}
              allItems={db}
            />
          ))}
        </ul>
      )}

      {external.length > 0 && (
        <>
          <div className="mt-6 mb-3 flex items-center gap-3 font-pixel text-xs text-ink-lo uppercase tracking-[0.2em]">
            <span>↓ download more like this</span>
            <span className="flex-1 border-t border-border" />
            <DownloadAllButton items={external} />
          </div>
          <ul className="card-vapor rounded-sm divide-y divide-border">
            {external.map((ext, idx) => (
              <ExternalRow
                key={ext.video_id}
                item={ext}
                position={db.length + idx + 1}
              />
            ))}
          </ul>
        </>
      )}

      {!isLoading && db.length === 0 && external.length === 0 && (
        <div className="card-vapor rounded-sm p-8 text-center font-pixel text-ink-lo">
          couldn't tune a radio for this track right now.
        </div>
      )}
    </section>
  )
}
