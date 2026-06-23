/**
 * Native-only filesystem primitives for offline downloads. Everything lives
 * under `Directory.Data/offline/` — private to the app, survives restarts, no
 * runtime permissions on modern Android. Audio is streamed straight to disk via
 * @capacitor/file-transfer (never held in memory as base64). The convertFileSrc
 * URLs handed back are what an <audio>/<img> element can actually load.
 *
 * Every export is a no-op / null off-native, so callers don't need to branch.
 */
import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { FileTransfer } from '@capacitor/file-transfer'
import type { PlaylistTrackRow } from '@/shared/api/types'

const DIR = Directory.Data
const ROOT = 'offline'
const MANIFEST = `${ROOT}/manifest.json`

/** One downloaded track, with everything needed to rebuild a queue item offline
 *  and to reference-count it across the playlists that pulled it in. */
export type ManifestEntry = {
  video_id: string
  codec: string
  bitrate: string
  title: string | null
  artist: string | null
  duration_sec: number | null
  thumbnail_url: string | null
  source_url: string
  /** Relative paths under Directory.Data — URLs are recomputed on load. */
  audioFile: string
  coverFile: string | null
  bytes: number
  /** Playlists this track was downloaded for; file is removed when empty. */
  playlistIds: string[]
}

/** On-disk shape: the downloaded tracks plus enough playlist metadata to render
 *  a downloaded playlist with no network (its name). */
export type Manifest = {
  tracks: ManifestEntry[]
  playlists: Record<string, { name: string }>
}

function emptyManifest(): Manifest {
  return { tracks: [], playlists: {} }
}

export function isOfflineSupported(): boolean {
  return Capacitor.isNativePlatform()
}

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function audioRel(videoId: string, codec: string, bitrate: string): string {
  return `${ROOT}/${safe(videoId)}__${safe(codec)}__${safe(bitrate)}.mp3`
}

function coverRel(videoId: string): string {
  return `${ROOT}/${safe(videoId)}.jpg`
}

async function ensureRoot(): Promise<void> {
  try {
    await Filesystem.mkdir({ path: ROOT, directory: DIR, recursive: true })
  } catch {
    // already exists
  }
}

/** Relative on-disk path → URL an <audio>/<img> element can load. */
export async function toPlayableUrl(relPath: string): Promise<string> {
  const { uri } = await Filesystem.getUri({ path: relPath, directory: DIR })
  return Capacitor.convertFileSrc(uri)
}

/** Stream a track's audio (and best-effort its cover) to disk. Returns the
 *  relative paths + audio byte size; throws if the audio download fails. */
export async function downloadTrackFiles(
  track: PlaylistTrackRow,
  streamUrl: string,
  coverRemoteUrl: string | null,
): Promise<{ audioFile: string; coverFile: string | null; bytes: number }> {
  await ensureRoot()

  const aRel = audioRel(track.video_id, track.codec, track.bitrate)
  const aUri = (await Filesystem.getUri({ path: aRel, directory: DIR })).uri
  await FileTransfer.downloadFile({ url: streamUrl, path: aUri })

  let cRel: string | null = null
  const coverSrc = coverRemoteUrl || track.thumbnail_url
  if (coverSrc) {
    try {
      const rel = coverRel(track.video_id)
      const cUri = (await Filesystem.getUri({ path: rel, directory: DIR })).uri
      await FileTransfer.downloadFile({ url: coverSrc, path: cUri })
      cRel = rel
    } catch {
      cRel = null // art is best-effort; audio is what matters
    }
  }

  let bytes = 0
  try {
    bytes = (await Filesystem.stat({ path: aRel, directory: DIR })).size ?? 0
  } catch {
    // stat is informational only
  }
  return { audioFile: aRel, coverFile: cRel, bytes }
}

export async function removeFiles(
  audioFile: string,
  coverFile: string | null,
): Promise<void> {
  for (const p of [audioFile, coverFile]) {
    if (!p) continue
    try {
      await Filesystem.deleteFile({ path: p, directory: DIR })
    } catch {
      // already gone
    }
  }
}

function basename(relPath: string): string {
  return relPath.split('/').pop() ?? relPath
}

/** Delete files under the offline dir that no manifest entry references. A
 *  download interrupted between writing a track's file and persisting the
 *  manifest (app killed mid-download) leaves the file orphaned with no way to
 *  reach it — this reclaims that space. Called once on hydrate. Returns how many
 *  files were removed. */
export async function reconcileOrphans(manifest: Manifest): Promise<number> {
  let removed = 0
  try {
    const { files } = await Filesystem.readdir({ path: ROOT, directory: DIR })
    const keep = new Set<string>([basename(MANIFEST)])
    for (const e of manifest.tracks) {
      keep.add(basename(e.audioFile))
      if (e.coverFile) keep.add(basename(e.coverFile))
    }
    for (const f of files) {
      // capacitor returns FileInfo objects; tolerate a plain-string shape too.
      const name = typeof f === 'string' ? f : f.name
      if (keep.has(name)) continue
      try {
        await Filesystem.deleteFile({ path: `${ROOT}/${name}`, directory: DIR })
        removed++
      } catch {
        // best-effort
      }
    }
  } catch {
    // dir doesn't exist yet → nothing to reconcile
  }
  return removed
}

export async function readManifest(): Promise<Manifest> {
  try {
    const { data } = await Filesystem.readFile({
      path: MANIFEST,
      directory: DIR,
      encoding: Encoding.UTF8,
    })
    const parsed = JSON.parse(data as string)
    return {
      tracks: Array.isArray(parsed?.tracks) ? parsed.tracks : [],
      playlists:
        parsed?.playlists && typeof parsed.playlists === 'object'
          ? parsed.playlists
          : {},
    }
  } catch {
    return emptyManifest() // no manifest yet
  }
}

export async function writeManifest(manifest: Manifest): Promise<void> {
  await ensureRoot()
  await Filesystem.writeFile({
    path: MANIFEST,
    directory: DIR,
    encoding: Encoding.UTF8,
    data: JSON.stringify(manifest),
  })
}
