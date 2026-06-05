import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AppHeader } from '@/shared/ui/AppHeader'
import { SearchBar } from '@/features/search/SearchBar'
import { SearchResults } from '@/features/search/SearchResults'
import { looksLikeUrl, useSearchResults } from '@/features/search/useSearch'
import { VideoMetadata } from '@/features/capture/VideoMetadata'
import { PlaylistTracks } from '@/features/capture/PlaylistTracks'
import { DownloadProgress } from '@/features/capture/DownloadProgress'
import { useCapture } from '@/features/capture/useCapture'
import { ErrorToast } from '@/shared/ui/Toast'
import { countActive, useJobs } from '@/shared/api/useJobs'

export default function CapturePage() {
  const c = useCapture()
  const jobsQuery = useJobs()
  const activeCount = countActive(jobsQuery.data)

  // Committed search query — set when user presses Enter / picks a suggestion.
  const [searchQuery, setSearchQuery] = useState('')
  const searchResults = useSearchResults(searchQuery)

  // True when the user is typing something different from the committed video.
  // While that's happening the previous video's panel would bleed through the
  // dropdown, so we hide it. URL-like input doesn't count — the user might just
  // be tweaking the URL of the same video.
  const trimmedInput = c.url.trim()
  const isTypingNewQuery =
    trimmedInput.length >= 2 &&
    !looksLikeUrl(trimmedInput) &&
    trimmedInput !== c.committedUrl

  const showMeta =
    (c.phase === 'ready' || c.phase === 'downloading' || c.phase === 'done') &&
    !isTypingNewQuery
  const showProgress = c.phase === 'downloading' || c.phase === 'done'
  const showSearchGrid = searchQuery.length >= 2 && c.phase === 'idle'

  const canStart =
    c.phase === 'ready' &&
    (c.meta.is_playlist || c.selectedFormat !== null || c.selectedAudio !== null)

  function handleSubmit(committed: string) {
    if (looksLikeUrl(committed)) {
      c.setUrl(committed)
      setSearchQuery('')
      c.analyze(committed)
    } else {
      // Free-text query → trigger the results grid below.
      setSearchQuery(committed)
      c.reset()
    }
  }

  function handlePickResult(url: string) {
    c.setUrl(url)
    setSearchQuery('')
    c.analyze(url)
  }

  return (
    <div className="relative z-10 min-h-full">
      <main className="max-w-5xl mx-auto px-6 py-8">
        <AppHeader queueCount={activeCount} />

        <SearchBar
          value={c.url}
          onChange={c.setUrl}
          onSubmit={handleSubmit}
          busy={c.phase === 'analyzing'}
        />

        {showSearchGrid && (
          <SearchResults
            query={searchQuery}
            results={searchResults.data?.results}
            isLoading={searchResults.isLoading}
            isError={searchResults.isError}
            errorMsg={searchResults.error instanceof Error ? searchResults.error.message : null}
            onPick={handlePickResult}
          />
        )}

        {showMeta &&
          (c.meta.is_playlist ? (
            <PlaylistTracks
              meta={c.meta}
              tracks={c.playlistTracks}
              thumbnailUrl={c.thumbnailUrl}
              quality={c.playlistQuality}
              onQualityChange={c.setPlaylistQuality}
            />
          ) : (
            <VideoMetadata
              meta={c.meta}
              formats={c.formats}
              thumbnailUrl={c.thumbnailUrl}
              selected={c.selectedFormat}
              onSelect={c.selectFormat}
              selectedAudio={c.selectedAudio}
              onSelectAudio={c.selectAudio}
            />
          ))}

        {showProgress ? (
          <DownloadProgress
            status={c.status}
            progress={c.progress}
            trackInfo={c.trackInfo}
            canStart={false}
            onStart={c.startDownload}
            onAbort={c.abort}
          />
        ) : (
          showMeta && (
            <DownloadProgress
              status={null}
              progress={0}
              trackInfo={null}
              canStart={canStart}
              onStart={c.startDownload}
              onAbort={c.abort}
            />
          )
        )}

        {c.phase === 'done' && c.completedAsImport && (
          <div className="mt-6 card-vapor rounded-sm p-5 flex items-center justify-between flex-wrap gap-3">
            <div>
              <div className="font-pixel text-xs text-ink-lo uppercase tracking-[0.2em] mb-1">
                ✓ {c.meta.is_playlist ? 'playlist imported' : 'track imported'}
              </div>
              <div className="font-sans text-ink-hi">
                {c.meta.is_playlist
                  ? 'tracks added to your library. ready to listen.'
                  : 'added to your library. ready to listen.'}
              </div>
            </div>
            <Link
              to="/library"
              className="font-pixel text-lg uppercase tracking-widest px-4 py-1 border border-hot bg-hot/15 text-ink-hi shadow-[var(--shadow-glow-hot)] hover:bg-hot/25 transition rounded-xs"
            >
              ♪ view library
            </Link>
          </div>
        )}

        <footer className="mt-12 text-center font-pixel text-sm text-ink-lo">
          ＲＥＴＲＯ ＷＡＶＥ · powered by yt-dlp &amp; ffmpeg
        </footer>
      </main>

      <ErrorToast message={c.errorMsg} onDismiss={() => {}} />
    </div>
  )
}
