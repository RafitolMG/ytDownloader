import type { SearchResultItem } from '@/shared/api/types'
import { SearchResultCard } from './SearchResultCard'

type Props = {
  query: string
  results: SearchResultItem[] | undefined
  isLoading: boolean
  isError: boolean
  errorMsg: string | null
  onPick: (url: string) => void
}

export function SearchResults({
  query,
  results,
  isLoading,
  isError,
  errorMsg,
  onPick,
}: Props) {
  return (
    <section className="mb-6">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="font-display text-2xl text-ink-hi tracking-wider">
          <span className="text-chromatic">RESULTS</span>
        </h2>
        <div className="font-pixel text-sm text-ink-lo">
          ░ for{' '}
          <span className="text-cool">"{query}"</span>
        </div>
      </div>

      {isLoading && (
        <div className="card-vapor rounded-sm p-5 font-pixel text-ink-mid">
          ··· scanning the wavelength ···
        </div>
      )}

      {isError && (
        <div className="card-vapor rounded-sm p-5 font-pixel text-crit border-crit/60">
          ✗ search failed{errorMsg ? ` — ${errorMsg}` : ''}
        </div>
      )}

      {!isLoading && !isError && results && results.length === 0 && (
        <div className="card-vapor rounded-sm p-5 font-pixel text-ink-mid">
          no signals matched. try another keyword.
        </div>
      )}

      {!isLoading && !isError && results && results.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {results.map((r) => (
            <SearchResultCard
              key={r.id}
              data={{
                title: r.title,
                channel: r.channel,
                thumbnail: r.thumbnail,
                duration_seconds: r.duration_seconds,
              }}
              onSelect={() => onPick(r.url)}
            />
          ))}
        </div>
      )}
    </section>
  )
}
