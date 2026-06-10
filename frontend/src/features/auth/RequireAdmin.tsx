import { Navigate, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from './AuthProvider'

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="min-h-full flex items-center justify-center">
        <span className="font-pixel text-xl text-ink-mid animate-pulse">
          // establishing session…
        </span>
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />
  }

  // Authenticated but not an admin — bounce to the catalog home.
  if (user.role !== 'ADMIN') {
    return <Navigate to="/" replace />
  }

  return <>{children}</>
}
