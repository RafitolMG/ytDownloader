import type { CatalogAccent, ExternalCatalogItem, LibraryItem } from '@/shared/api/types'

/** Map an external (undownloaded) candidate to a player item that streams via
 * the preview proxy. The sentinel codec 'preview' tells the player to use
 * /api/preview/{id} instead of the library stream. */
export function toPreviewItem(e: ExternalCatalogItem): LibraryItem {
  return {
    video_id: e.video_id,
    codec: 'preview',
    bitrate: '0',
    title: e.title,
    artist: e.artist,
    duration_sec: e.duration_sec,
    thumbnail_url: e.thumbnail_url,
    source_url: e.source_url,
    file_size: null,
    added_at: '',
    source_playlist_title: null,
  }
}

// Accent → literal Tailwind classes (kept whole so the JIT sees them).
export const ACCENT: Record<
  CatalogAccent,
  { border: string; text: string; grad: string; glow: string }
> = {
  hot: {
    border: 'border-hot/50',
    text: 'text-hot',
    grad: 'from-hot/40 via-violet/20 to-cool/20',
    glow: 'hover:shadow-[var(--shadow-glow-hot)]',
  },
  cool: {
    border: 'border-cool/50',
    text: 'text-cool',
    grad: 'from-cool/40 via-violet/20 to-hot/20',
    glow: 'hover:shadow-[var(--shadow-glow-cool)]',
  },
  violet: {
    border: 'border-violet/50',
    text: 'text-violet',
    grad: 'from-violet/40 via-hot/20 to-cool/20',
    glow: 'hover:shadow-[var(--shadow-glow-cool)]',
  },
}
