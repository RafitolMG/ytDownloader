import { useEffect, useRef, useState } from 'react'
import type { HistoryItem, SearchResultItem } from '@/shared/api/types'
import { looksLikeUrl, useDropdownPreview, useHistory } from './useSearch'
import { isCoarsePointer } from '@/shared/lib/device'

type Mode = 'idle' | 'history' | 'preview' | 'preview-loading' | 'url'

type Props = {
  value: string
  onChange: (next: string) => void
  /** Fires when the user commits — Enter, suggestion click, or history click. */
  onSubmit: (committed: string) => void
  busy: boolean
}

type Row = {
  key: string
  /** What gets committed on click / Enter. */
  pickValue: string
  thumbnail: string | null
  title: string
  subtitle: string | null
  durationSec: number | null
}

/**
 * Unified input: detects URL vs free-text query and surfaces the right
 * dropdown for each — recent downloads when empty, live video previews while
 * typing, and a "press Enter to analyze" hint when it looks like a URL.
 */
export function SearchBar({ value, onChange, onSubmit, busy }: Props) {
  const [focused, setFocused] = useState(false)
  const [activeIdx, setActiveIdx] = useState<number>(-1)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const trimmed = value.trim()
  const isUrl = looksLikeUrl(trimmed)
  const previewQ = useDropdownPreview(value)
  const historyQ = useHistory(8)

  const previewResults: SearchResultItem[] = previewQ.data?.results ?? []
  const history: HistoryItem[] = historyQ.data?.items ?? []

  let mode: Mode = 'idle'
  if (focused) {
    if (!trimmed) mode = history.length > 0 ? 'history' : 'idle'
    else if (isUrl) mode = 'url'
    else if (previewQ.isLoading || (previewQ.isFetching && previewResults.length === 0))
      mode = 'preview-loading'
    else if (previewResults.length > 0) mode = 'preview'
  }

  const rows: Row[] =
    mode === 'preview'
      ? previewResults.map((r) => ({
          key: r.id,
          pickValue: r.url,
          thumbnail: r.thumbnail,
          title: r.title,
          subtitle: r.channel,
          durationSec: r.duration_seconds,
        }))
      : mode === 'history'
        ? history.map((h) => ({
            key: h.id,
            pickValue: h.url,
            thumbnail: h.thumbnail,
            title: h.title ?? h.url,
            subtitle: h.channel,
            durationSec: h.duration_seconds,
          }))
        : []

  // Reset highlight whenever the option list changes or dropdown closes.
  useEffect(() => {
    setActiveIdx(-1)
  }, [mode, rows.length])

  // Click outside → close dropdown.
  useEffect(() => {
    if (!focused) return
    function onClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setFocused(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [focused])

  function commit(next: string) {
    onChange(next)
    onSubmit(next)
    setFocused(false)
    inputRef.current?.blur()
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setFocused(false)
      return
    }

    if (e.key === 'ArrowDown') {
      if (rows.length === 0) return
      e.preventDefault()
      setActiveIdx((i) => (i + 1) % rows.length)
    } else if (e.key === 'ArrowUp') {
      if (rows.length === 0) return
      e.preventDefault()
      setActiveIdx((i) => (i <= 0 ? rows.length - 1 : i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (activeIdx >= 0 && activeIdx < rows.length) {
        commit(rows[activeIdx].pickValue)
      } else if (trimmed) {
        commit(trimmed)
      }
    }
  }

  return (
    <section className="card-vapor rounded-sm p-3 sm:p-5 mb-6 relative" ref={wrapperRef}>
      <div className="font-pixel text-xs text-ink-lo uppercase tracking-[0.2em] mb-2">
        ░▒▓ stream capture ▓▒░
      </div>
      <form
        className="flex items-center gap-2 sm:gap-3 font-pixel text-lg sm:text-2xl"
        onSubmit={(e) => {
          e.preventDefault()
          if (!busy && trimmed) commit(trimmed)
        }}
      >
        <span className="text-hot">{'>'}</span>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={handleKeyDown}
          placeholder="search or paste URL..."
          spellCheck={false}
          autoComplete="off"
          autoFocus={!isCoarsePointer}
          className="flex-1 bg-transparent border-none outline-none text-ink-hi placeholder:text-ink-lo font-pixel text-lg sm:text-2xl caret-cool min-w-0"
        />
        <span className="caret-blink text-cool">▮</span>
      </form>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          disabled={busy || !trimmed}
          onClick={() => commit(trimmed)}
          className="font-pixel text-lg uppercase tracking-widest px-4 py-1 border border-cool/60 text-cool hover:bg-cool/10 hover:shadow-[var(--shadow-glow-cool)] disabled:opacity-40 disabled:cursor-not-allowed transition rounded-xs"
        >
          {busy ? '··· scanning' : isUrl ? '──▶ analyze' : '──▶ search'}
        </button>
      </div>

      {mode !== 'idle' && (
        <Dropdown>
          {mode === 'url' && (
            <div className="px-4 py-3 font-pixel text-ink-mid">
              ◆ url detected — press <span className="text-cool">enter</span> to
              analyze
            </div>
          )}

          {mode === 'preview-loading' && (
            <div className="px-4 py-3 font-pixel text-ink-mid">
              ··· tuning the wavelength ···
            </div>
          )}

          {mode === 'preview' && (
            <DropdownHeader>top results · enter to see all</DropdownHeader>
          )}
          {mode === 'history' && (
            <DropdownHeader>recent downloads</DropdownHeader>
          )}

          {rows.map((row, i) => (
            <DropdownRow
              key={row.key}
              row={row}
              active={i === activeIdx}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => commit(row.pickValue)}
            />
          ))}
        </Dropdown>
      )}
    </section>
  )
}

function Dropdown({ children }: { children: React.ReactNode }) {
  // Solid background — `card-vapor` is 55% opacity which lets the underlying
  // video panel bleed through the dropdown, making it look broken.
  return (
    <div className="absolute left-0 right-0 top-full mt-2 z-30 bg-page-mid border border-border rounded-sm overflow-hidden max-h-[28rem] overflow-y-auto shadow-[0_8px_32px_rgba(0,0,0,0.6)]">
      {children}
    </div>
  )
}

function DropdownHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 py-2 font-pixel text-xs text-ink-lo uppercase tracking-[0.2em] border-b border-border">
      // {children}
    </div>
  )
}

function DropdownRow({
  row,
  active,
  onMouseEnter,
  onClick,
}: {
  row: Row
  active: boolean
  onMouseEnter: () => void
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={`w-full text-left flex items-center gap-3 px-3 py-2 font-pixel transition ${
        active
          ? 'bg-cool/10 text-ink-hi'
          : 'text-ink-mid hover:bg-violet/10 hover:text-ink-hi'
      }`}
    >
      <div className="relative w-16 sm:w-24 aspect-video flex-shrink-0 rounded-xs overflow-hidden border border-border bg-page-mid">
        {row.thumbnail ? (
          <img
            src={row.thumbnail}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-violet/40 via-hot/20 to-cool/30" />
        )}
        {row.durationSec != null && (
          <span className="absolute bottom-0.5 right-0.5 font-pixel text-[10px] leading-none bg-page/80 text-cool px-1 py-0.5 rounded-xs">
            {fmtDuration(row.durationSec)}
          </span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-sans text-sm font-semibold leading-snug line-clamp-2 break-all">
          {row.title}
        </div>
        {row.subtitle && (
          <div className="text-sm text-ink-lo truncate mt-0.5">
            {row.subtitle}
          </div>
        )}
      </div>
    </button>
  )
}

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
