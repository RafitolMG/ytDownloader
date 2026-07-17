import { Capacitor } from '@capacitor/core'
import { readCoverDataUrl } from '@/features/offline/storage'

/**
 * The media-session plugin's native artwork loader can't fetch a remote or
 * capacitor_file URL — it does a blocking, unguarded HttpURLConnection that
 * crashes the app on any failure (see mediaSession.ts). So on native we hand it
 * the cover as an inline `data:` URL instead, which the plugin renders directly.
 * This also gives the native MediaSession real artwork independent of whether
 * Chromium can load the URL (offline, WiFi-without-internet), and prepares the
 * ground for surfaces that read the native session (e.g. Android Auto later).
 *
 * Downscaled to keep the metadata payload small; cached per video.
 */
const MAX_PX = 512
const cache = new Map<string, string>()

/** Resolve a track's cover to a downscaled `data:` URL for the native media
 *  session. Prefers a downloaded cover (works offline), else fetches the remote
 *  URL (native `fetch` is routed through CapacitorHttp, so no CORS/tainted
 *  canvas). Returns null on web or on any failure — callers fall back to the
 *  plain URL, which the WebView session can still load when it's reachable. */
export async function nativeCoverDataUrl(
  videoId: string,
  remoteUrl: string | null,
): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null
  const cached = cache.get(videoId)
  if (cached) return cached

  let out: string | null = null
  const local = await readCoverDataUrl(videoId)
  if (local) {
    out = await downscale(local)
  } else if (remoteUrl?.startsWith('data:')) {
    out = await downscale(remoteUrl)
  } else if (remoteUrl) {
    const blob = await fetchBlob(remoteUrl)
    if (blob) {
      const obj = URL.createObjectURL(blob)
      out = await downscale(obj)
      URL.revokeObjectURL(obj)
    }
  }
  if (out) cache.set(videoId, out)
  return out
}

async function fetchBlob(url: string): Promise<Blob | null> {
  try {
    const resp = await fetch(url)
    return resp.ok ? await resp.blob() : null
  } catch {
    return null
  }
}

/** Load `src` (a data:/blob: URL — always same-origin, never taints the canvas)
 *  and re-encode it to a downscaled JPEG data URL. */
function downscale(src: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, MAX_PX / Math.max(img.naturalWidth, img.naturalHeight, 1))
      const w = Math.max(1, Math.round(img.naturalWidth * scale))
      const h = Math.max(1, Math.round(img.naturalHeight * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return resolve(null)
      ctx.drawImage(img, 0, 0, w, h)
      try {
        resolve(canvas.toDataURL('image/jpeg', 0.85))
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = src
  })
}
