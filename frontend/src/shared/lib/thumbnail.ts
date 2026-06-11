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

/** Resolve the best artwork URL for a context that can't do onError/onLoad
 *  fallback (e.g. the native media-session notification, where the plugin just
 *  loads whatever URL we hand it). Probes the maxres frame: returns it only if
 *  it actually loaded at full size — not YouTube's 120×90 grey placeholder
 *  (served as HTTP 200) — otherwise the original. Resolves with the original on
 *  error or after a short timeout. */
export function resolveArtworkUrl(
  url: string | null | undefined,
): Promise<string | null | undefined> {
  if (!url) return Promise.resolve(url)
  const hi = hiResThumbnail(url)
  if (!hi || hi === url) return Promise.resolve(url)
  return new Promise((resolve) => {
    let done = false
    const finish = (u: string | null | undefined) => {
      if (!done) {
        done = true
        resolve(u)
      }
    }
    const img = new Image()
    img.onload = () => finish(img.naturalWidth > 120 ? hi : url)
    img.onerror = () => finish(url)
    img.src = hi
    setTimeout(() => finish(url), 4000)
  })
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
