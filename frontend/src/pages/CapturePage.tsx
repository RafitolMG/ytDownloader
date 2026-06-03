import { AppHeader } from '@/shared/ui/AppHeader'
import { UrlInput } from '@/features/capture/UrlInput'
import { VideoMetadata } from '@/features/capture/VideoMetadata'
import { DownloadProgress } from '@/features/capture/DownloadProgress'
import { useCapture } from '@/features/capture/useCapture'
import { ErrorToast } from '@/shared/ui/Toast'
import { countActive, useJobs } from '@/shared/api/useJobs'

export default function CapturePage() {
  const c = useCapture()
  const jobsQuery = useJobs()
  const activeCount = countActive(jobsQuery.data)

  const showMeta = c.phase === 'ready' || c.phase === 'downloading' || c.phase === 'done'
  const showProgress = c.phase === 'downloading' || c.phase === 'done'

  const canStart = c.phase === 'ready' && (c.meta.is_playlist || c.selectedFormat !== null)

  return (
    <div className="relative z-10 min-h-full">
      <main className="max-w-4xl mx-auto px-6 py-8">
        <AppHeader queueCount={activeCount} />

        <UrlInput
          value={c.url}
          onChange={c.setUrl}
          onAnalyze={c.analyze}
          busy={c.phase === 'analyzing'}
        />

        {showMeta && (
          <VideoMetadata
            meta={c.meta}
            formats={c.formats}
            thumbnailUrl={c.thumbnailUrl}
            selected={c.selectedFormat}
            onSelect={c.selectFormat}
            playlistQuality={c.playlistQuality}
            onPlaylistQualityChange={c.setPlaylistQuality}
          />
        )}

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

        <footer className="mt-12 text-center font-pixel text-sm text-ink-lo">
          ＲＥＴＲＯ ＷＡＶＥ · powered by yt-dlp &amp; ffmpeg
        </footer>
      </main>

      <ErrorToast message={c.errorMsg} onDismiss={() => {}} />
    </div>
  )
}
