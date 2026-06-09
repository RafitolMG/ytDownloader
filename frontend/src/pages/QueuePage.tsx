import { AppHeader } from '@/shared/ui/AppHeader'
import { QueueList } from '@/features/queue/QueueList'
import { countActive, useJobs } from '@/shared/api/useJobs'

/** Standalone /queue route — kept for deep links/bookmarks. Day to day the
 * queue is reached through the header drawer; both render the same QueueList. */
export default function QueuePage() {
  const jobsQuery = useJobs({ refetchInterval: 5_000 })
  const activeCount = countActive(jobsQuery.data)

  return (
    <div className="relative z-10 min-h-full">
      <main className="max-w-6xl mx-auto px-3 sm:px-6 py-4 sm:py-8">
        <AppHeader queueCount={activeCount} />

        <div className="font-pixel text-xs text-ink-lo uppercase tracking-[0.2em] mb-6">
          ░▒▓ event log ▓▒░
        </div>

        <QueueList />

        <footer className="mt-12 text-center font-pixel text-sm text-ink-lo">
          ＲＥＴＲＯ ＷＡＶＥ · powered by yt-dlp &amp; ffmpeg
        </footer>
      </main>
    </div>
  )
}
