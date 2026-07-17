import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { AudioPlayerProvider } from '@/features/player/AudioPlayerProvider'
import { OfflineProvider } from '@/features/offline/OfflineProvider'
import { ToastProvider } from '@/shared/ui/ToastProvider'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      // Drop cached data 5 min after the last observer unmounts so navigating
      // away from heavy lists (catalog/library) frees memory instead of pinning it.
      gcTime: 5 * 60_000,
    },
  },
})

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <OfflineProvider>
            {/* ToastProvider wraps the player so the player can surface toasts
                (e.g. a track that fails to load). Children get both contexts. */}
            <ToastProvider>
              <AudioPlayerProvider>{children}</AudioPlayerProvider>
            </ToastProvider>
          </OfflineProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
