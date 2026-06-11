import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import LoginPage from '@/pages/LoginPage'
import { RequireAuth } from '@/features/auth/RequireAuth'
import { RequireAdmin } from '@/features/auth/RequireAdmin'

// Each page is its own chunk so the initial load ships only the app shell +
// LoginPage (kept eager — it's the unauthenticated entry). Heavy/rarely-used
// pages like Admin no longer ride in the main bundle for every user.
const CapturePage = lazy(() => import('@/pages/CapturePage'))
const QueuePage = lazy(() => import('@/pages/QueuePage'))
const CatalogPage = lazy(() => import('@/pages/CatalogPage'))
const AlbumsPage = lazy(() => import('@/pages/AlbumsPage'))
const PlaylistsPage = lazy(() => import('@/pages/PlaylistsPage'))
const PlaylistDetailPage = lazy(() => import('@/pages/PlaylistDetailPage'))
const LikedSongsPage = lazy(() => import('@/pages/LikedSongsPage'))
const StatsPage = lazy(() => import('@/pages/StatsPage'))
const ImportPage = lazy(() => import('@/pages/ImportPage'))
const SettingsPage = lazy(() => import('@/pages/SettingsPage'))
const AdminPage = lazy(() => import('@/pages/AdminPage'))

/** Themed splash while a route chunk loads — beats a blank flash on first nav. */
function RouteFallback() {
  return (
    <div className="relative z-10 min-h-[60vh] flex items-center justify-center">
      <div className="font-pixel text-sm uppercase tracking-[0.3em] text-cool animate-pulse">
        ░▒▓ loading ▓▒░
      </div>
    </div>
  )
}

export function AppRouter() {
  return (
    <Suspense fallback={<RouteFallback />}>
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
          path="/stats"
          element={
            <RequireAuth>
              <StatsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/import"
          element={
            <RequireAuth>
              <ImportPage />
            </RequireAuth>
          }
        />
        <Route
          path="/settings"
          element={
            <RequireAuth>
              <SettingsPage />
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
    </Suspense>
  )
}
