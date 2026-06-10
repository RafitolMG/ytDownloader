import { Navigate, Route, Routes } from 'react-router-dom'
import CapturePage from '@/pages/CapturePage'
import QueuePage from '@/pages/QueuePage'
import CatalogPage from '@/pages/CatalogPage'
import AlbumsPage from '@/pages/AlbumsPage'
import PlaylistsPage from '@/pages/PlaylistsPage'
import PlaylistDetailPage from '@/pages/PlaylistDetailPage'
import LikedSongsPage from '@/pages/LikedSongsPage'
import LoginPage from '@/pages/LoginPage'
import AdminPage from '@/pages/AdminPage'
import { RequireAuth } from '@/features/auth/RequireAuth'
import { RequireAdmin } from '@/features/auth/RequireAdmin'

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
      {/* Library folded into the catalog's "mine" view — keep the old path
          working for bookmarks. */}
      <Route path="/library" element={<Navigate to="/catalog" replace />} />
      <Route
        path="/catalog"
        element={
          <RequireAuth>
            <CatalogPage />
          </RequireAuth>
        }
      />
      <Route
        path="/albums"
        element={
          <RequireAuth>
            <AlbumsPage />
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
      {/* Pinned "Liked Songs" — must precede the :id route. */}
      <Route
        path="/playlists/liked"
        element={
          <RequireAuth>
            <LikedSongsPage />
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
      {/* RequireAdmin already covers auth — don't double-wrap in RequireAuth. */}
      <Route
        path="/admin"
        element={
          <RequireAdmin>
            <AdminPage />
          </RequireAdmin>
        }
      />
    </Routes>
  )
}
