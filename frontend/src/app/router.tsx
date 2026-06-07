import { Route, Routes } from 'react-router-dom'
import CapturePage from '@/pages/CapturePage'
import QueuePage from '@/pages/QueuePage'
import LibraryPage from '@/pages/LibraryPage'
import CatalogPage from '@/pages/CatalogPage'
import PlaylistsPage from '@/pages/PlaylistsPage'
import PlaylistDetailPage from '@/pages/PlaylistDetailPage'
import LoginPage from '@/pages/LoginPage'
import { RequireAuth } from '@/features/auth/RequireAuth'

export function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <CapturePage />
          </RequireAuth>
        }
      />
      <Route
        path="/queue"
        element={
          <RequireAuth>
            <QueuePage />
          </RequireAuth>
        }
      />
      <Route
        path="/library"
        element={
          <RequireAuth>
            <LibraryPage />
          </RequireAuth>
        }
      />
      <Route
        path="/catalog"
        element={
          <RequireAuth>
            <CatalogPage />
          </RequireAuth>
        }
      />
      <Route
        path="/playlists"
        element={
          <RequireAuth>
            <PlaylistsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/playlists/:id"
        element={
          <RequireAuth>
            <PlaylistDetailPage />
          </RequireAuth>
        }
      />
    </Routes>
  )
}
