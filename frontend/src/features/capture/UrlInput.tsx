import { isCoarsePointer } from '@/shared/lib/device'

type Props = {
  value: string
  onChange: (next: string) => void
  onAnalyze: () => void
  busy: boolean
}

export function UrlInput({ value, onChange, onAnalyze, busy }: Props) {
  return (
    <section className="card-vapor rounded-sm p-5 mb-6">
      <div className="font-pixel text-xs text-ink-lo uppercase tracking-[0.2em] mb-2">
        ░▒▓ stream capture ▓▒░
      </div>
      <form
        className="flex items-center gap-3 font-pixel text-2xl"
        onSubmit={(e) => {
          e.preventDefault()
          if (!busy) onAnalyze()
        }}
      >
        <span className="text-hot">{'>'}</span>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="enter signal..."
          spellCheck={false}
          autoComplete="off"
          autoFocus={!isCoarsePointer}
          className="flex-1 bg-transparent border-none outline-none text-ink-hi placeholder:text-ink-lo font-pixel text-2xl caret-cool"
        />
        <span className="caret-blink text-cool">▮</span>
      </form>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          disabled={busy || !value.trim()}
          onClick={onAnalyze}
          className="font-pixel text-lg uppercase tracking-widest px-4 py-1 border border-cool/60 text-cool hover:bg-cool/10 hover:shadow-[var(--shadow-glow-cool)] disabled:opacity-40 disabled:cursor-not-allowed transition rounded-xs"
        >
          {busy ? '··· scanning' : '──▶ analyze'}
        </button>
      </div>
    </section>
  )
}
