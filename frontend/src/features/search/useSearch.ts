import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/shared/api/client'

/**
 * Treat anything that smells like a URL as a URL — even partial forms users
 * paste mid-typing. Keeps the autocomplete dropdown out of the way when the
 * user is clearly pasting a link.
 */
export function looksLikeUrl(s: string): boolean {
  const t = s.trim()
  if (!t) return false
  return /^(https?:\/\/|www\.|youtube\.com|youtu\.be)/i.test(t)
}

/** Debounce any value. Returns a state that lags `value` by `delay` ms. */
export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(t)
  }, [value, delay])
  return debounced
}

/**
 * Live dropdown preview as the user types: a handful of real video results
 * (with thumbnails) instead of plain-text autocomplete. Debounced 350ms — long
 * enough to skip the keystroke-by-keystroke storm, short enough to feel snappy.
 * Disabled when the input looks like a URL.
 */
export function useDropdownPreview(rawQuery: string) {
  const q = useDebounced(rawQuery.trim(), 350)
  const enabled = q.length >= 2 && !looksLikeUrl(q)
  return useQuery({
    queryKey: ['search', 'preview', q],
    queryFn: () => api.search(q, 6),
    enabled,
    staleTime: 5 * 60_000,
  })
}

/**
 * Full video results. Only fires when the caller commits a query (Enter, click
 * on a suggestion). We don't debounce here because the user has already paid
 * the typing cost — they're waiting for the grid now.
 */
export function useSearchResults(committedQuery: string) {
  const q = committedQuery.trim()
  return useQuery({
    queryKey: ['search', 'results', q],
    queryFn: () => api.search(q, 20),
    enabled: q.length >= 2 && !looksLikeUrl(q),
    staleTime: 5 * 60_000,
  })
}

/** Recent completed downloads — empty-state dropdown content. */
export function useHistory(limit = 12) {
  return useQuery({
    queryKey: ['history', limit],
    queryFn: () => api.history(limit),
    staleTime: 10_000,
  })
}
