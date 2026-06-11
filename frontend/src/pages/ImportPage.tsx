import { useCallback, useRef, useState } from 'react'
import { AppHeader } from '@/shared/ui/AppHeader'
import { api, wsUrl } from '@/shared/api/client'
import { ApiError } from '@/shared/api/client'
import { countActive, useJobs } from '@/shared/api/useJobs'

type Phase = 'idle' | 'running' | 'done' | 'error'

type Skipped = { title: string; message: string }

/**
 * Bulk-import a wishlist into the library: paste a public Spotify playlist link
 * (read via the embed, ~100-track cap) or a list — Exportify CSV / "Artist -
 * Title" lines (unlimited). Each track is re-found on YouTube Music and
 * downloaded; tracks with no confident match are reported, not guessed.
 */
export default function ImportPage() {
  const jobsQuery = useJobs()
  const activeCount = countActive(jobsQuery.data)

  const [source, setSource] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const [playlistName, setPlaylistName] = useState<string | null>(null)
  const [capped, setCapped] = useState(false)
  const [total, setTotal] = useState(0)
  const [pct, setPct] = useState(0)
  const [currentTitle, setCurrentTitle] = useState<string | null>(null)
  const [counts, setCounts] = useState({ imported: 0, reused: 0, no_match: 0, skipped: 0 })
  const [skips, setSkips] = useState<Skipped[]>([])

  const wsRef = useRef<WebSocket | null>(null)

  const reset = () => {
    setPlaylistName(null)
    setCapped(false)
    setTotal(0)
    setPct(0)
    setCurrentTitle(null)
    setCounts({ imported: 0, reused: 0, no_match: 0, skipped: 0 })
    setSkips([])
    setErrorMsg(null)
  }

  const subscribe = useCallback((jobId: string) => {
    wsRef.current?.close()
    const ws = new WebSocket(wsUrl(`/ws/progress/${jobId}`))
    wsRef.current = ws
    ws.onmessage = (ev) => {
      const d = JSON.parse(ev.data) as Record<string, unknown>
      switch (d.type) {
        case 'metadata':
          setPlaylistName((d.title as string) ?? null)
          setTotal((d.count as number) ?? 0)
          setCapped(Boolean(d.capped))
          break
        case 'track':
          setCurrentTitle((d.title as string) ?? null)
          break
        case 'progress':
          setPct((d.value as number) ?? 0)
          break
        case 'track_skipped': {
          const message = (d.message as string) ?? ''
          const noMatch = message.includes('no match')
          setCounts((c) => ({
            ...c,
            no_match: c.no_match + (noMatch ? 1 : 0),
            skipped: c.skipped + (noMatch ? 0 : 1),
          }))
          setSkips((s) => [...s, { title: (d.title as string) ?? '?', message }])
          break
        }
        case 'done':
          setCounts({
            imported: (d.imported as number) ?? 0,
            reused: (d.reused as number) ?? 0,
            no_match: (d.no_match as number) ?? 0,
            skipped: (d.skipped as number) ?? 0,
          })
          setPct(100)
          setCurrentTitle(null)
          setPhase('done')
          ws.close()
          break
        case 'error':
          setErrorMsg((d.message as string) ?? 'import failed')
          setPhase('error')
          ws.close()
          break
        case 'cancelled':
          setPhase('idle')
          ws.close()
          break
      }
    }
  }, [])

  const start = useCallback(async () => {
    if (!source.trim() || phase === 'running') return
    reset()
    setPhase('running')
    try {
      const { job_id } = await api.importTracklist(source.trim())
      subscribe(job_id)
    } catch (e) {
      setErrorMsg(e instanceof ApiError ? e.message : String(e))
      setPhase('error')
    }
  }, [source, phase, subscribe])

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // let the same file be picked again later
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setSource(String(reader.result ?? ''))
    reader.readAsText(file)
  }

  const running = phase === 'running'

  return (
    <div className="relative z-10 min-h-full">
      <main className="max-w-3xl mx-auto px-3 sm:px-6 py-4 sm:py-8 pb-40 sm:pb-32">
        <AppHeader queueCount={activeCount} />

        <div className="font-pixel text-xs text-ink-lo uppercase tracking-[0.2em] mb-2">
          ░▒▓ bulk import ▓▒░
        </div>

        <section className="card-vapor rounded-sm p-4 sm:p-5 mb-6">
          <textarea
            value={source}
            onChange={(e) => setSource(e.target.value)}
            disabled={running}
            rows={6}
            spellCheck={false}
            placeholder={
              'Pega una playlist pública de Spotify…\n' +
              'https://open.spotify.com/playlist/…\n\n' +
              '…o una lista:  Artista - Título  (una por línea)\n' +
              'Quevedo - Columbia\n' +
              'Rosalía - Despechá'
            }
            className="w-full bg-page/60 border border-border rounded-xs px-3 py-2 font-pixel text-sm text-ink-hi placeholder:text-ink-lo outline-none focus:border-cool/70 resize-y min-h-[8rem] disabled:opacity-60"
          />
          <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
            <p className="font-pixel text-[0.7rem] text-ink-lo leading-snug">
              URL de Spotify → hasta 100 · lista/CSV → sin límite. Cada tema se
              busca en YouTube Music y se descarga.
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <label
                className={`font-pixel text-base uppercase tracking-widest px-4 py-1.5 border border-violet/60 text-violet rounded-xs whitespace-nowrap transition ${
                  running
                    ? 'opacity-40'
                    : 'cursor-pointer hover:bg-violet/10 hover:shadow-[var(--shadow-glow-violet)]'
                }`}
              >
                ▤ subir csv
                <input
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  disabled={running}
                  onChange={onFile}
                  className="hidden"
                />
              </label>
              <button
                type="button"
                onClick={start}
                disabled={running || !source.trim()}
                className="font-pixel text-base uppercase tracking-widest px-4 py-1.5 border border-cool/60 text-cool hover:bg-cool/10 hover:shadow-[var(--shadow-glow-cool)] disabled:opacity-40 transition rounded-xs whitespace-nowrap"
              >
                {running ? '··· importing' : '⬇ import'}
              </button>
            </div>
          </div>
        </section>

        {phase === 'error' && (
          <div className="card-vapor rounded-sm p-4 mb-6 border border-crit/50 font-pixel text-sm text-crit">
            ⚠ {errorMsg}
          </div>
        )}

        {(running || phase === 'done') && (
          <section className="card-vapor rounded-sm p-4 sm:p-5 mb-6">
            <div className="flex items-baseline justify-between mb-2 gap-3">
              <div className="font-sans text-sm font-semibold text-ink-hi truncate">
                {playlistName ?? 'importing…'}
                {capped && (
                  <span className="ml-2 font-pixel text-[0.65rem] text-sun">
                    ⚠ primeras 100
                  </span>
                )}
              </div>
              <div className="font-pixel text-xs text-ink-lo tabular-nums">
                {total > 0 ? `${total} temas` : ''}
              </div>
            </div>

            <div className="h-2 bg-page rounded-xs overflow-hidden border border-border mb-2">
              <div
                className="h-full bg-gradient-to-r from-violet via-hot to-cool transition-[width]"
                style={{ width: `${pct}%` }}
              />
            </div>

            {running && currentTitle && (
              <div className="font-pixel text-xs text-ink-mid truncate mb-3">
                ▶ {currentTitle}
              </div>
            )}

            <div className="flex items-center gap-3 flex-wrap font-pixel text-xs">
              <span className="text-cool">✓ {counts.imported} nuevas</span>
              {counts.reused > 0 && <span className="text-violet">↺ {counts.reused} ya tenías</span>}
              {counts.no_match > 0 && <span className="text-sun">✕ {counts.no_match} sin match</span>}
              {counts.skipped > 0 && <span className="text-crit">⚠ {counts.skipped} fallidas</span>}
            </div>

            {phase === 'done' && (
              <div className="mt-3 font-pixel text-xs text-cool uppercase tracking-widest">
                ✓ import completo
              </div>
            )}
          </section>
        )}

        {skips.length > 0 && (
          <section className="card-vapor rounded-sm p-4 sm:p-5">
            <div className="font-pixel text-xs text-sun uppercase tracking-[0.2em] mb-2">
              // sin match / fallidas ({skips.length})
            </div>
            <ul className="divide-y divide-border/60">
              {skips.map((s, i) => (
                <li key={i} className="py-1.5">
                  <div className="font-sans text-sm text-ink-mid truncate">{s.title}</div>
                  <div className="font-pixel text-[0.65rem] text-ink-lo truncate">{s.message}</div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  )
}
