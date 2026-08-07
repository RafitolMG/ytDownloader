import type { CatalogItem, LibraryItem, PlaylistTrackRow } from '@/shared/api/types'

/** Map a catalog row (catalog/discover/radio db hit) to a player/library item.
 *  Lives here rather than in a page so the player and the pages share it without
 *  importing each other (it used to be copied to dodge an import cycle). */
export function catalogToLibrary(c: CatalogItem): LibraryItem {
  return {
    video_id: c.video_id,
    codec: c.codec,
    bitrate: c.bitrate,
    title: c.title,
    artist: c.artist,
    album: c.album,
    album_artist: c.album_artist,
    release_year: c.release_year,
    duration_sec: c.duration_sec,
    thumbnail_url: c.thumbnail_url,
    source_url: c.source_url,
    file_size: c.file_size,
    added_at: c.downloaded_at,
    source_playlist_title: null,
  }
}

/** Map a library item to a playlist track row — used to feed owned album tracks
 *  into the offline download flow, which is keyed on the playlist-row shape. */
export function libraryToPlaylistRow(it: LibraryItem, position = 0): PlaylistTrackRow {
  return {
    video_id: it.video_id,
    codec: it.codec,
    bitrate: it.bitrate,
    title: it.title,
    artist: it.artist,
    album: it.album ?? null,
    album_artist: it.album_artist ?? null,
    release_year: it.release_year ?? null,
    duration_sec: it.duration_sec,
    thumbnail_url: it.thumbnail_url,
    source_url: it.source_url,
    file_size: it.file_size,
    position,
    added_at: it.added_at,
  }
}

/** Map a catalog row to a playlist track row — same offline-download use as
 *  {@link libraryToPlaylistRow}, for the DB tracks of a remote album. */
export function catalogToPlaylistRow(c: CatalogItem, position = 0): PlaylistTrackRow {
  return {
    video_id: c.video_id,
    codec: c.codec,
    bitrate: c.bitrate,
    title: c.title,
    artist: c.artist,
    album: c.album ?? null,
    album_artist: c.album_artist ?? null,
    release_year: c.release_year ?? null,
    duration_sec: c.duration_sec,
    thumbnail_url: c.thumbnail_url,
    source_url: c.source_url,
    file_size: c.file_size,
    position,
    added_at: c.downloaded_at,
  }
}

/** Map a playlist track row to a player/library item. */
export function playlistRowToLibrary(t: PlaylistTrackRow): LibraryItem {
  return {
    video_id: t.video_id,
    codec: t.codec,
    bitrate: t.bitrate,
    title: t.title,
    artist: t.artist,
    duration_sec: t.duration_sec,
    thumbnail_url: t.thumbnail_url,
    source_url: t.source_url,
    file_size: t.file_size,
    added_at: t.added_at,
    source_playlist_title: null,
  }
}
