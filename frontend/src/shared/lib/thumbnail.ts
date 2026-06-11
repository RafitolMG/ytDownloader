/** Upgrade an i.ytimg.com thumbnail to the full-resolution still frame.
 *
 * Stored thumbnails are `hqdefault.jpg` (480×360); blown up to a square cover on
 * the now-playing screen they look blurry. `maxresdefault.jpg` is 1280×720.
 * Not every video has a maxres frame though, and YouTube serves a 120×90 grey
 * placeholder (as HTTP 200, not 404) when it's missing — so callers must use
 * `thumbnailFallback` on both onError AND onLoad to detect that and restore the
 * original. Non-ytimg URLs pass through unchanged. */
export function hiResThumbnail(
  url: string | null | undefined,
): string | null | undefined {
  if (!url) return url
  const m = url.match(/i\.ytimg\.com\/vi\/([^/]+)\//)
  return m ? `https://i.ytimg.com/vi/${m[1]}/maxresdefault.jpg` : url
}

/** Restore the original thumbnail when the hi-res frame fails to load (onError →
 *  naturalWidth 0) or resolves to YouTube's 120×90 grey "no maxres" placeholder
 *  (onLoad → naturalWidth ≤ 120). Wire to BOTH onError and onLoad. Guards
 *  against a loop by bailing once the src is already the original. */
export function thumbnailFallback(
  e: { currentTarget: HTMLImageElement },
  original: string | null | undefined,
): void {
  const img = e.currentTarget
  if (!original || img.src === original) return
  const failed = img.naturalWidth === 0
  const placeholder = img.naturalWidth > 0 && img.naturalWidth <= 120
  if (failed || placeholder) img.src = original
}
