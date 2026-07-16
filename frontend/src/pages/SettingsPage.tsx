import { AppHeader } from '@/shared/ui/AppHeader'
import { useAuth } from '@/features/auth/AuthProvider'
import { API_BASE } from '@/shared/api/client'
import { countActive, useJobs } from '@/shared/api/useJobs'

/** Account + app info. Home for future per-device/account preferences. */
export default function SettingsPage() {
  const { user, logout } = useAuth()
  const jobsQuery = useJobs()
  const activeCount = countActive(jobsQuery.data)

  return (
    <div className="relative z-10 min-h-full">
      <main className="max-w-2xl mx-auto px-3 sm:px-6 py-4 sm:py-8 pb-bottombars">
        <AppHeader queueCount={activeCount} />

        <div className="font-pixel text-xs text-ink-lo uppercase tracking-[0.2em] mb-4">
          ░▒▓ configuración ▓▒░
        </div>

        <section className="card-vapor rounded-sm p-4 sm:p-5 mb-4">
          <div className="font-pixel text-xs text-cool uppercase tracking-[0.2em] mb-3">
            // cuenta
          </div>
          <Row label="usuario" value={user?.username ?? '—'} />
          <Row label="rol" value={user?.role ?? '—'} />
          <button
            type="button"
            onClick={() => void logout()}
            className="mt-4 font-pixel text-sm uppercase tracking-widest px-4 py-1.5 border border-crit/60 text-crit hover:bg-crit/10 transition rounded-xs"
          >
            ⏻ cerrar sesión
          </button>
        </section>

        <section className="card-vapor rounded-sm p-4 sm:p-5">
          <div className="font-pixel text-xs text-cool uppercase tracking-[0.2em] mb-3">
            // reproducción
          </div>
          <p className="font-pixel text-sm text-ink-mid leading-relaxed">
            La radio infinita (∞) está <span className="text-cool">siempre activa</span>: al
            acabarse la cola se encadenan temas relacionados de tu biblioteca.
          </p>
        </section>

        <section className="card-vapor rounded-sm p-4 sm:p-5 mt-4">
          <div className="font-pixel text-xs text-cool uppercase tracking-[0.2em] mb-3">
            // app
          </div>
          <Row label="backend" value={API_BASE || 'mismo origen'} />
        </section>
      </main>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 border-b border-border/40 last:border-0">
      <span className="font-pixel text-xs text-ink-lo uppercase tracking-widest">{label}</span>
      <span className="font-sans text-sm text-ink-hi truncate">{value}</span>
    </div>
  )
}
