import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { error: Error | null }

/** Catches render-time crashes anywhere below it so one broken component shows
 * a recoverable message instead of unmounting the whole app to a blank page.
 * Class component because React only exposes error catching via the class API. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface it for debugging; a real logger could ship this somewhere.
    console.error('Uncaught error in render tree:', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="relative z-10 min-h-screen flex items-center justify-center px-6 py-8">
        <div className="card-vapor rounded-sm p-8 w-full max-w-md text-center">
          <div className="font-pixel text-lg text-crit uppercase tracking-[0.2em] mb-3">
            ⚠ system fault
          </div>
          <p className="font-pixel text-sm text-ink-mid mb-6">
            something glitched out. the rest of the app is fine — reload to jack
            back in.
          </p>
          <pre className="font-pixel text-xs text-ink-lo bg-page/60 border border-border rounded-xs p-3 mb-6 overflow-x-auto text-left">
            {this.state.error.message || String(this.state.error)}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="w-full font-pixel text-lg uppercase tracking-widest px-5 py-2 border border-hot bg-hot/15 text-ink-hi shadow-[var(--shadow-glow-hot)] hover:bg-hot/25 transition rounded-xs"
          >
            ↻ reload
          </button>
        </div>
      </div>
    )
  }
}
