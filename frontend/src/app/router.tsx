import { Route, Routes } from 'react-router-dom'
import CapturePage from '@/pages/CapturePage'
import QueuePage from '@/pages/QueuePage'
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
    </Routes>
  )
}
