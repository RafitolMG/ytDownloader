import shutil
import yt_dlp
import os
import subprocess
import re
from urllib.parse import urlparse, parse_qs

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_LOCAL_FFMPEG = os.path.join(_PROJECT_ROOT, 'bin', 'ffmpeg.exe' if os.name == 'nt' else 'ffmpeg')


def _get_ffmpeg_path():
    """Return path to ffmpeg: local bin/ folder first, then system PATH."""
    if os.path.isfile(_LOCAL_FFMPEG):
        return _LOCAL_FFMPEG
    return shutil.which('ffmpeg')


_COOKIES_DATA_PATH: str | None = None
_COOKIES_DATA_ERROR: str | None = None


def _resolve_cookies_file() -> str | None:
    """Return the cookies.txt path to use, or None if no cookies are configured.

    Priority:
      1. YT_COOKIES_DATA env var — base64-encoded cookies.txt. Decoded once
         to a tempfile so yt-dlp can read it via 'cookiefile'. base64 keeps
         the value on a single line with no shell-special characters, which
         matters because Coolify (and most platforms) source env files as
         bash and dotted tab-separated lines would be parsed as commands.
      2. YT_COOKIES_FILE env var (prod with a mounted file).
      3. cookies.txt in the project root (dev convenience).
    """
    global _COOKIES_DATA_PATH, _COOKIES_DATA_ERROR
    data = os.environ.get('YT_COOKIES_DATA', '').strip()
    if data:
        if _COOKIES_DATA_PATH is None or not os.path.isfile(_COOKIES_DATA_PATH):
            import base64
            import tempfile
            try:
                content = base64.b64decode(data, validate=True).decode('utf-8')
            except Exception as e:
                _COOKIES_DATA_ERROR = f"base64 decode failed: {e}"
            else:
                _COOKIES_DATA_ERROR = None
                fd, path = tempfile.mkstemp(prefix='yt-cookies-', suffix='.txt')
                try:
                    with os.fdopen(fd, 'w') as f:
                        f.write(content)
                except Exception:
                    os.unlink(path)
                    raise
                _COOKIES_DATA_PATH = path
        if _COOKIES_DATA_PATH and os.path.isfile(_COOKIES_DATA_PATH):
            return _COOKIES_DATA_PATH

    env_path = os.environ.get('YT_COOKIES_FILE', '').strip()
    if env_path and os.path.isfile(env_path):
        return env_path
    legacy = os.path.join(_PROJECT_ROOT, 'cookies.txt')
    if os.path.isfile(legacy):
        return legacy
    return None


def get_cookies_expiry() -> dict | None:
    """Parse the resolved Netscape cookies.txt for expiry info so the admin panel
    can warn BEFORE YouTube auth lapses (the worst silent prod failure — a stale
    cookie just starts 503ing extraction). Pure file parse, no yt-dlp call.

    Returns {total, expired_count, min_expiry (unix|None), days_remaining (int|
    None)} or None when no cookies file is configured. NEVER returns cookie
    names/values. Fails soft to None on any read/parse error.
    """
    import time as _time

    path = _resolve_cookies_file()
    if not path:
        return None
    now = _time.time()
    expiries: list[float] = []
    expired = 0
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for raw in f:
                line = raw.rstrip("\n")
                # Comments start with '#', EXCEPT the '#HttpOnly_' prefix which
                # marks a real cookie line in many exports.
                if line.startswith("#") and not line.startswith("#HttpOnly_"):
                    continue
                parts = line.split("\t")
                if len(parts) < 7:
                    continue
                try:
                    exp = float(parts[4])  # Netscape field 5 (0-indexed 4)
                except ValueError:
                    continue
                if exp <= 0:
                    continue  # session cookie — no expiry
                expiries.append(exp)
                if exp < now:
                    expired += 1
    except OSError:
        return None

    if not expiries:
        return {"total": 0, "expired_count": expired, "min_expiry": None, "days_remaining": None}
    min_exp = min(expiries)
    return {
        "total": len(expiries),
        "expired_count": expired,
        "min_expiry": int(min_exp),
        "days_remaining": int((min_exp - now) // 86400),
    }


def _get_cookie_opts() -> dict:
    """
    Return the yt-dlp options common to every YouTube call: cookies (to avoid
    bot detection) plus an explicit JS runtime (to solve YouTube's signature /
    n-param challenges).

    Cookies priority:
      1. cookies.txt resolved via _resolve_cookies_file.
      2. Auto-detect an installed browser and extract cookies from it (Windows).
      None if neither source is available — local residential IPs often still
      work without them.

    JS runtime: yt-dlp 2026.3.17's default `js_runtimes` only enables Deno,
    so Node is treated as unavailable even when installed. We override with
    both — Deno gets priority when present (local dev / future images) and
    Node is the fallback that the container actually ships.

    The format in this yt-dlp version is `{runtime: {config}}` (dict of
    runtime name to config dict). An empty `{}` config means "use the
    binary from PATH" — that's what we want both for the Node 22 we
    install via NodeSource in the Dockerfile and for whatever Deno the
    dev may have locally. Passing a list (the format the CLI parser
    produces, and the format on master) or `None` as the value triggers
    400-style errors from yt-dlp before extraction even begins.
    """
    # `player_client`: try multiple YouTube player clients so that "Topic"
    # channel uploads (auto-generated YouTube Music tracks like
    # `<Artist> - Topic`) resolve. The default `web` client often returns
    # "Video unavailable" for them; `web_music` is the YouTube Music client
    # that does resolve them. `ios` and `tv` are extra fallbacks for cases
    # where `web` is blocked by anti-bot.
    opts: dict = {
        'js_runtimes': {'deno': {}, 'node': {}},
        'extractor_args': {
            'youtube': {'player_client': ['default', 'web_music', 'ios', 'tv']},
        },
    }

    cookies_file = _resolve_cookies_file()
    if cookies_file:
        opts['cookiefile'] = cookies_file
    elif os.name == 'nt':
        # Chrome and Edge use app-bound encryption since v127 which breaks DPAPI
        # extraction from outside the browser process. Firefox still works fine.
        appdata = os.environ.get('APPDATA', '')
        firefox_dir = os.path.join(appdata, 'Mozilla', 'Firefox', 'Profiles')
        if os.path.isdir(firefox_dir):
            opts['cookiesfrombrowser'] = ('firefox',)

    return opts


def download_video(url, format_code, output_folder, on_progress=None):
    ydl_opts = {
        'format': format_code,
        'outtmpl': os.path.join(output_folder, '%(title)s.%(ext)s'),
        'progress_hooks': [_progress_hook(on_progress)],
        'restrictfilenames': True,
        **_get_cookie_opts(),
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        result = ydl.extract_info(url, download=True)
        video_filename = ydl.prepare_filename(result)
        video_ext = result['ext']
        audio_codec = result['acodec']
        duration = float(result.get('duration') or 0)
        fps = float(result.get('fps') or 30)

    return video_filename, video_ext, audio_codec, _calculate_total_frames(duration, fps)


def download_audio(url, output_folder, on_progress=None):
    ydl_opts = {
        'format': 'bestaudio/best',
        'outtmpl': os.path.join(output_folder, '%(title)s_audio.%(ext)s'),
        'progress_hooks': [_progress_hook(on_progress)],
        'restrictfilenames': True,
        **_get_cookie_opts(),
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        result = ydl.extract_info(url, download=True)
        audio_filename = ydl.prepare_filename(result)
        audio_ext = result['ext']

    return audio_filename, audio_ext


def download_audio_only(url, format_code, output_folder, on_progress=None):
    """
    Download audio-only track and embed metadata + cover art.
    If ffmpeg is available, converts to MP3 and embeds thumbnail as album art.
    Without ffmpeg, downloads the native audio format with metadata tags only.
    """
    ffmpeg = _get_ffmpeg_path()

    postprocessors = [{'key': 'FFmpegMetadata', 'add_metadata': True}]

    ydl_opts = {
        'format': format_code,
        'outtmpl': os.path.join(output_folder, '%(title)s.%(ext)s'),
        'progress_hooks': [_progress_hook(on_progress)],
        'postprocessors': postprocessors,
        **_get_cookie_opts(),
    }

    if ffmpeg:
        ydl_opts['ffmpeg_location'] = ffmpeg
        ydl_opts['writethumbnail'] = True
        # Order matters: extract audio first, then embed metadata, then embed thumbnail
        postprocessors.insert(0, {
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'mp3',
            'preferredquality': '0',  # VBR best quality
        })
        postprocessors.append({'key': 'EmbedThumbnail'})

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])


def get_video_codec(path):
    """Return the video stream codec_name of `path` ('h264', 'av1', ...) or None."""
    ffmpeg = _get_ffmpeg_path()
    if ffmpeg is None:
        return None
    ffprobe = ffmpeg.replace('ffmpeg', 'ffprobe', 1)
    try:
        out = subprocess.check_output(
            [ffprobe, '-v', 'error', '-select_streams', 'v:0',
             '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', path],
            text=True,
        ).strip()
        return out or None
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def transcode_video_to_h264(input_file, output_file, video_frames, on_progress=None):
    """
    Re-encode the video stream of `input_file` to H.264, copying the audio.
    Used when the source is AV1 (or anything non-H.264) so the result plays
    everywhere. Slow — CPU-bound.
    """
    ffmpeg = _get_ffmpeg_path()
    if ffmpeg is None:
        raise RuntimeError("FFmpeg not found. Place ffmpeg.exe in the bin/ folder or add it to your PATH.")

    cmd = [
        ffmpeg, '-y',
        '-i', input_file,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '20',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        output_file,
    ]
    try:
        process = subprocess.Popen(cmd, stderr=subprocess.PIPE, universal_newlines=True)
    except FileNotFoundError:
        raise RuntimeError("FFmpeg not found. Place ffmpeg.exe in the bin/ folder or add it to your PATH.")

    progress_pattern = re.compile(r"frame=(\s*\d+)")
    while True:
        line = process.stderr.readline()
        if not line:
            break
        match = progress_pattern.search(line)
        if match and on_progress and video_frames:
            frame_number = int(match.group(1))
            on_progress(min(100.0, frame_number / video_frames * 100))

    process.communicate()
    if process.returncode != 0:
        raise RuntimeError("FFmpeg transcode returned a non-zero exit code.")


def merge_audio_video(video_file, audio_file, output_file, video_frames, on_progress=None):
    ffmpeg = _get_ffmpeg_path()
    if ffmpeg is None:
        raise RuntimeError("FFmpeg not found. Place ffmpeg.exe in the bin/ folder or add it to your PATH.")

    cmd = [
        ffmpeg,
        '-y',
        '-i', video_file,
        '-i', audio_file,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-strict', 'experimental',
        output_file
    ]

    try:
        process = subprocess.Popen(cmd, stderr=subprocess.PIPE, universal_newlines=True)
    except FileNotFoundError:
        raise RuntimeError("FFmpeg not found. Place ffmpeg.exe in the bin/ folder or add it to your PATH.")

    progress_pattern = re.compile(r"frame=(\s*\d+)")

    while True:
        line = process.stderr.readline()
        if not line:
            break
        match = progress_pattern.search(line)
        if match and on_progress:
            frame_number = int(match.group(1))
            progress_percent = (frame_number / video_frames) * 100
            on_progress(progress_percent)

    process.communicate()
    if process.returncode != 0:
        raise RuntimeError("FFmpeg process returned a non-zero exit code.")


def get_available_resolutions(url, audio_only=False):
    """
    Returns a dict with:
      - 'formats': list of dicts with keys: format_code, resolution, ext, needs_merge, size_display
      - 'thumbnail_url': str or None
      - 'ffmpeg_available': bool
    Raises on error.
    """
    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'ignore_no_formats_error': True,  # don't raise if default format selection fails
        **_get_cookie_opts(),
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)

    thumbnail_url = info.get('thumbnail')
    ffmpeg_available = _get_ffmpeg_path() is not None
    formats = []

    for yt_format in info.get('formats', []):
        if audio_only:
            # Audio-only streams: no video codec, has audio codec
            if yt_format.get('vcodec') != 'none':
                continue
            if yt_format.get('acodec') == 'none':
                continue

            filesize = yt_format.get('filesize') or yt_format.get('filesize_approx')
            if filesize is None:
                continue

            abr = yt_format.get('abr') or 0
            if abr:
                quality = f"{int(abr)}kbps"
            else:
                quality = yt_format.get('format_note', 'Unknown')

            size_mb = float(filesize) / (1024 * 1024)
            size_display = f'{size_mb / 1024:.2f} GB' if size_mb >= 1024 else f'{size_mb:.2f} MB'

            formats.append({
                'format_code': yt_format['format_id'],
                'resolution': quality,
                'ext': yt_format.get('ext', 'Unknown'),
                'needs_merge': False,
                'size_display': size_display,
            })
        else:
            if yt_format.get('vcodec') == 'none' or yt_format.get('filesize') is None:
                continue
            if yt_format.get('ext') != 'mp4':
                continue

            needs_merge = yt_format.get('acodec') == 'none'
            if needs_merge and not ffmpeg_available:
                continue

            size_mb = float(yt_format['filesize']) / (1024 * 1024)
            if size_mb >= 1024:
                size_display = f'{size_mb / 1024:.2f} GB'
            else:
                size_display = f'{size_mb:.2f} MB'

            height = yt_format.get('height')
            resolution = f'{height}p' if height else (yt_format.get('resolution') or 'Unknown')
            vcodec = (yt_format.get('vcodec') or '').lower()

            # Codec preference: H.264 (avc1) > AV1 (av01) > anything else.
            # Lower number wins. AV1 has best compression but the worst
            # playback compatibility (older players show video but no audio).
            if vcodec.startswith('avc'):
                codec_rank = 0
            elif vcodec.startswith('av01'):
                codec_rank = 1
            else:
                codec_rank = 2

            formats.append({
                'format_code': yt_format['format_id'],
                'resolution': resolution,
                'height': height or 0,
                'codec_rank': codec_rank,
                'size_bytes': int(yt_format['filesize']),
                'ext': yt_format.get('ext', 'Unknown'),
                'needs_merge': needs_merge,
                'size_display': size_display,
            })

    # Deduplicate: per height, prefer H.264 (avc1) for instant compatibility;
    # AV1 only if no H.264 is offered (YouTube serves AV1-only at 1440p/2160p).
    # AV1-source files are re-encoded to H.264 after merge so they play
    # everywhere — that step is slow but the user gets a working file.
    by_height: dict[int, dict] = {}
    for f in formats:
        h = f['height']
        cur = by_height.get(h)
        if cur is None or (f['codec_rank'], f['size_bytes']) < (cur['codec_rank'], cur['size_bytes']):
            by_height[h] = f
    formats = sorted(by_height.values(), key=lambda f: f['height'], reverse=True)

    return {
        'formats': formats,
        'thumbnail_url': thumbnail_url,
        'ffmpeg_available': ffmpeg_available,
        'is_music': _looks_like_music(info),
    }


def _extract_music_meta(info: dict) -> dict:
    """Pull artist/album fields out of a yt-dlp info dict into a normalized shape.

    yt-dlp exposes `artists` (a list — every credited performer) for YouTube
    Music tracks, plus `album` / `album_artist` / `release_year`. The legacy
    single `artist` string only ever held the first name, which is why the app
    used to show one artist. We prefer the `artists` list and join it for the
    display string so collaborations render every name.

    Returns: { artists: list[str], artist: str|None, album, album_artist,
               release_year } — `artist` is the ", "-joined display string,
    falling back through artist → uploader → channel when no list is present.
    """
    artists = info.get("artists")
    if not isinstance(artists, list):
        artists = []
    # Clean + de-dupe while preserving order.
    seen: set[str] = set()
    cleaned: list[str] = []
    for a in artists:
        name = (a or "").strip()
        if name and name not in seen:
            seen.add(name)
            cleaned.append(name)
    artists = cleaned

    if artists:
        display = ", ".join(artists)
    else:
        display = (info.get("artist") or info.get("uploader") or info.get("channel"))
        if display:
            display = display.strip() or None

    year = info.get("release_year")
    if year is None:
        rd = info.get("release_date") or info.get("upload_date") or ""
        if isinstance(rd, str) and len(rd) >= 4 and rd[:4].isdigit():
            year = int(rd[:4])
    try:
        year = int(year) if year is not None else None
    except (TypeError, ValueError):
        year = None

    return {
        "artists": artists,
        "artist": display,
        "album": (info.get("album") or None),
        "album_artist": (info.get("album_artist") or None),
        "release_year": year,
    }


def _looks_like_music(info: dict) -> bool:
    """Heuristic for "this video is a song, not a vlog/tutorial/whatever".

    The library is meant to hold actual music. Random audio extracted from a
    non-music video would clutter it (and accumulate unbounded DB rows). We
    surface this flag so the frontend hides the "add to library" option when
    it's almost certainly the wrong choice.

    Positive signals:
      - `categories` includes 'Music' (most reliable — YouTube's own tag).
      - Uploader/channel ends with " - Topic" (auto-generated music uploads
        from YouTube Music — always music).
      - yt-dlp populated music metadata (`artist` / `track` / `album`),
        which it does for YouTube Music tracks.
    """
    cats = info.get('categories') or []
    if any((c or '').lower() == 'music' for c in cats):
        return True
    for key in ('uploader', 'channel'):
        name = (info.get(key) or '').strip()
        if name.endswith(' - Topic'):
            return True
    if info.get('artist') or info.get('track') or info.get('album'):
        return True
    return False


def get_basic_info(url):
    """
    Return the minimum metadata needed for history: title, uploader,
    duration, thumbnail. One yt-dlp call, no download.
    """
    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'extract_flat': True,
        'ignore_no_formats_error': True,
        **_get_cookie_opts(),
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)

    return {
        'title': info.get('title'),
        'uploader': info.get('uploader') or info.get('channel'),
        'duration_sec': int(info.get('duration') or 0) or None,
        'thumbnail_url': info.get('thumbnail'),
    }


def is_playlist(url):
    """Return True if the URL contains a playlist identifier."""
    try:
        return 'list' in parse_qs(urlparse(url).query)
    except Exception:
        return False


def get_playlist_info(url):
    """
    Returns a dict with:
      - 'title': playlist title
      - 'count': number of videos
      - 'thumbnail_url': thumbnail URL or None
    """
    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'extract_flat': True,
        **_get_cookie_opts(),
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)

    entries = info.get('entries') or []
    thumbnail = info.get('thumbnail')
    if not thumbnail and entries:
        thumbnail = entries[0].get('thumbnail')

    return {
        'title': info.get('title', 'Unknown Playlist'),
        'count': len(entries),
        'thumbnail_url': thumbnail,
    }


def get_playlist_tracks(url):
    """
    Returns playlist metadata + a list of every track, suitable for the UI
    to preview before downloading.

    Shape:
      {
        'title': str,
        'count': int,
        'thumbnail_url': str | None,
        'tracks': [
          {
            'id': str,
            'title': str,
            'url': str,        # canonical watch URL
            'duration_sec': int | None,
            'thumbnail': str | None,
          },
          ...
        ]
      }
    """
    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'extract_flat': 'in_playlist',
        **_get_cookie_opts(),
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)

    entries = info.get('entries') or []
    thumbnail = info.get('thumbnail')
    if not thumbnail and entries:
        thumbnail = entries[0].get('thumbnail')

    tracks = []
    for e in entries:
        if not e:
            continue
        vid = e.get('id')
        if not vid:
            continue
        # Prefer the largest thumbnail when entries expose a list.
        thumb = e.get('thumbnail')
        if not thumb:
            thumbs = e.get('thumbnails') or []
            if thumbs:
                thumb = thumbs[-1].get('url')
        duration = e.get('duration')
        emeta = _extract_music_meta(e)
        tracks.append({
            'id': vid,
            'title': e.get('title') or vid,
            # Display artist = all credited names joined (flat entries usually
            # only carry `channel`/`uploader`, but album/artist data, when
            # present, is captured too). Per-track richer metadata is filled in
            # at download time from the full extraction.
            'uploader': emeta['artist'],
            'artists': emeta['artists'],
            'album': emeta['album'],
            'album_artist': emeta['album_artist'],
            'release_year': emeta['release_year'],
            'url': e.get('url') or f'https://www.youtube.com/watch?v={vid}',
            'duration_sec': int(duration) if duration else None,
            'thumbnail': thumb,
        })

    return {
        'title': info.get('title', 'Unknown Playlist'),
        'count': len(tracks),
        'thumbnail_url': thumbnail,
        'tracks': tracks,
    }


_AUDIO_QUALITIES = {
    # alias        → (yt-dlp codec,  preferred quality string)
    'audio':    ('mp3',  '0'),    # legacy: best mp3 VBR
    'mp3-192':  ('mp3',  '192'),
    'mp3-320':  ('mp3',  '320'),
    'm4a':      ('m4a',  '0'),    # best m4a (AAC)
    'flac':     ('flac', '0'),    # lossless
}


def parse_audio_quality(quality: str):
    """Return (codec, bitrate, ext) for an audio quality preset alias.
    Raises ValueError if the alias is unknown."""
    if quality not in _AUDIO_QUALITIES:
        raise ValueError(f"Unknown audio quality: {quality}")
    codec, bitrate = _AUDIO_QUALITIES[quality]
    # For our supported codecs (mp3/m4a/flac) the codec name == file extension.
    return codec, bitrate, codec


def get_single_video_info(url):
    """
    Resolve a single-video URL to the metadata we need for library imports
    *without* downloading. Returns:
      { 'id', 'title', 'uploader', 'duration_sec', 'thumbnail', 'webpage_url' }
    Raises if the URL is not a single video (no `id`).
    """
    # Metadata-only call: pass `process=False` to skip yt-dlp's format-selection
    # phase entirely. Otherwise `process_video_result` raises "Requested format
    # is not available" on YouTube tracks whose available formats none of the
    # default selectors can resolve (audio-only music entries, weird codec
    # combos from a datacenter IP, etc.) — even though we're not downloading.
    # The raw `_real_extract` result still carries id/title/uploader/duration/
    # thumbnail/webpage_url, which is all we need.
    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'skip_download': True,
        **_get_cookie_opts(),
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False, process=False)
    vid = info.get('id')
    if not vid:
        raise RuntimeError("yt-dlp returned no video id for this URL")
    duration = info.get('duration')
    meta = _extract_music_meta(info)
    return {
        'id': vid,
        'title': info.get('title') or vid,
        # `uploader` is the display artist (all credited names joined), kept
        # under this key for backward-compat with set_metadata/job rows.
        'uploader': meta['artist'],
        'artists': meta['artists'],
        'album': meta['album'],
        'album_artist': meta['album_artist'],
        'release_year': meta['release_year'],
        'duration_sec': int(duration) if duration else None,
        'thumbnail': info.get('thumbnail'),
        'webpage_url': info.get('webpage_url') or url,
    }


def is_audio_quality(format_code: str) -> bool:
    """Return True if `format_code` matches an audio-quality preset alias."""
    return format_code in _AUDIO_QUALITIES


def get_audio_stream_url(url):
    """
    Resolve a direct, ready-to-stream audio URL for a video without downloading.

    Returns { 'url': <googlevideo direct url>, 'ext': <container>, 'duration': int|None }.
    Used to *preview* a track that isn't in the library yet — the backend proxies
    these bytes (YouTube URLs are IP-locked, so the browser can't fetch them).

    Picks the best audio-only progressive format; falls back to whatever yt-dlp
    resolves as the top-level URL.
    """
    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'skip_download': True,
        'format': 'bestaudio/best',
        **_get_cookie_opts(),
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)

    formats = info.get('formats') or []
    audio = [
        f for f in formats
        if f.get('url')
        and f.get('acodec') not in (None, 'none')
        and f.get('vcodec') in (None, 'none')
    ]
    audio.sort(key=lambda f: (f.get('abr') or f.get('tbr') or 0))
    best = audio[-1] if audio else None

    direct = best['url'] if best else info.get('url')
    ext = (best or {}).get('ext') or info.get('ext') or 'webm'
    return {'url': direct, 'ext': ext, 'duration': info.get('duration')}


def download_track_audio(url, codec, bitrate, dest_path, on_progress=None):
    """
    Download a single video as audio with the given codec+bitrate, writing the
    final post-processed file to `dest_path`. Creates parent dirs as needed.

    Returns the music metadata dict (`_extract_music_meta` shape, plus `title`)
    captured from the actual extraction — this is the only path that sees the
    full per-video info for playlist/album imports (flat playlist entries don't
    carry artists/album), so callers use it to register accurate tags.

    Implementation note: yt-dlp's FFmpegExtractAudio rewrites the file extension
    *after* download, so we let yt-dlp produce the file in a per-call tmp dir
    (under dest_path's parent) and then move the result atomically into place.
    """
    import tempfile

    ffmpeg = _get_ffmpeg_path()
    if not ffmpeg:
        raise RuntimeError(
            "ffmpeg is required for audio extraction but was not found on PATH"
        )

    parent_dir = os.path.dirname(dest_path)
    os.makedirs(parent_dir, exist_ok=True)

    work_dir = tempfile.mkdtemp(prefix="ytdl_track_", dir=parent_dir)

    def _hook(d):
        if on_progress is None or d.get('status') != 'downloading':
            return
        try:
            downloaded = d.get('downloaded_bytes') or 0
            total = d.get('total_bytes') or d.get('total_bytes_estimate') or 0
            if total:
                on_progress(downloaded / total * 100)
        except (ValueError, ZeroDivisionError):
            pass

    ydl_opts = {
        'format': 'bestaudio/best',
        'outtmpl': os.path.join(work_dir, 'track.%(ext)s'),
        'progress_hooks': [_hook],
        'restrictfilenames': True,
        'ffmpeg_location': ffmpeg,
        'postprocessors': [
            {'key': 'FFmpegExtractAudio', 'preferredcodec': codec, 'preferredquality': bitrate},
            {'key': 'FFmpegMetadata', 'add_metadata': True},
        ],
        **_get_cookie_opts(),
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)

        meta = _extract_music_meta(info or {})
        meta['title'] = (info or {}).get('title')

        produced = None
        for fname in os.listdir(work_dir):
            if fname.startswith('track.'):
                produced = os.path.join(work_dir, fname)
                break
        if not produced or not os.path.isfile(produced):
            raise RuntimeError("ffmpeg produced no audio file")

        # Move atomically into place (same filesystem since work_dir is a child
        # of parent_dir).
        if os.path.exists(dest_path):
            os.remove(dest_path)
        os.replace(produced, dest_path)
        return meta
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def download_audio_file(url, codec, bitrate, output_folder, on_progress=None):
    """
    Download a single video as audio (codec+bitrate) into `output_folder`,
    naming the file after the video title — same convention as `download_video`.
    Returns the absolute path of the produced file.

    Used when the user wants the audio as a downloadable file rather than a
    library import. Library imports go through `download_track_audio` which
    writes to a content-addressed library path.
    """
    ffmpeg = _get_ffmpeg_path()
    if not ffmpeg:
        raise RuntimeError(
            "ffmpeg is required for audio extraction but was not found on PATH"
        )

    ydl_opts = {
        'format': 'bestaudio/best',
        'outtmpl': os.path.join(output_folder, '%(title)s.%(ext)s'),
        'progress_hooks': [_progress_hook(on_progress)],
        'restrictfilenames': True,
        'ffmpeg_location': ffmpeg,
        'postprocessors': [
            {'key': 'FFmpegExtractAudio', 'preferredcodec': codec, 'preferredquality': bitrate},
            {'key': 'FFmpegMetadata', 'add_metadata': True},
        ],
        **_get_cookie_opts(),
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])

    # FFmpegExtractAudio rewrites the extension after download; scan the
    # output dir for the actual produced file.
    for fname in os.listdir(output_folder):
        if fname.lower().endswith(f'.{codec}'):
            return os.path.join(output_folder, fname)
    raise RuntimeError(f"yt-dlp produced no .{codec} file in {output_folder}")


def download_playlist(url, quality, output_folder, on_progress=None, on_video_start=None):
    """
    Download all videos in a playlist.

    quality:
      Video:  'best' | '2160' | '1440' | '1080' | '720' | '480' | '360'
      Audio:  'audio' | 'mp3-192' | 'mp3-320' | 'm4a' | 'flac'
    on_progress(percent)            — current video download progress 0-100
    on_video_start(index, total, title) — called when each new video starts
    """
    ffmpeg = _get_ffmpeg_path()
    is_audio = quality in _AUDIO_QUALITIES

    _fmt = {
        'best':  'bestvideo[ext=mp4]+bestaudio/best',
        '2160':  'bestvideo[height<=2160][ext=mp4]+bestaudio/bestvideo[height<=2160]+bestaudio/best[height<=2160]',
        '1440':  'bestvideo[height<=1440][ext=mp4]+bestaudio/bestvideo[height<=1440]+bestaudio/best[height<=1440]',
        '1080':  'bestvideo[height<=1080][ext=mp4]+bestaudio/bestvideo[height<=1080]+bestaudio/best[height<=1080]',
        '720':   'bestvideo[height<=720][ext=mp4]+bestaudio/bestvideo[height<=720]+bestaudio/best[height<=720]',
        '480':   'bestvideo[height<=480][ext=mp4]+bestaudio/bestvideo[height<=480]+bestaudio/best[height<=480]',
        '360':   'bestvideo[height<=360][ext=mp4]+bestaudio/bestvideo[height<=360]+bestaudio/best[height<=360]',
    }
    fmt = 'bestaudio/best' if is_audio else _fmt.get(quality, _fmt['best'])

    postprocessors = []
    if is_audio and ffmpeg:
        codec, pref_q = _AUDIO_QUALITIES[quality]
        postprocessors = [
            {'key': 'FFmpegExtractAudio', 'preferredcodec': codec, 'preferredquality': pref_q},
            {'key': 'FFmpegMetadata', 'add_metadata': True},
        ]

    state = {'last_index': None}

    def _hook(d):
        if d['status'] != 'downloading':
            return
        if on_progress:
            try:
                downloaded = d.get('downloaded_bytes', 0)
                total = d.get('total_bytes') or d.get('total_bytes_estimate', 0)
                if total:
                    on_progress(downloaded / total * 100)
            except (ValueError, ZeroDivisionError):
                pass
        if on_video_start:
            info = d.get('info_dict', {})
            idx = info.get('playlist_index')
            if idx is not None and idx != state['last_index']:
                state['last_index'] = idx
                on_video_start(idx, info.get('n_entries', '?'), info.get('title', ''))

    ydl_opts = {
        'format': fmt,
        'outtmpl': os.path.join(output_folder, '%(playlist_index)s - %(title)s.%(ext)s'),
        'progress_hooks': [_hook],
        'ignoreerrors': True,
        'restrictfilenames': True,
        'postprocessors': postprocessors,
        **_get_cookie_opts(),
    }

    if ffmpeg:
        ydl_opts['ffmpeg_location'] = ffmpeg
        if not is_audio:
            ydl_opts['merge_output_format'] = 'mp4'

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])


def _calculate_total_frames(duration, fps):
    return int(duration * fps)


def _progress_hook(on_progress):
    def hook(d):
        if on_progress is None or d['status'] != 'downloading':
            return
        try:
            downloaded = d.get('downloaded_bytes') or 0
            total = d.get('total_bytes') or d.get('total_bytes_estimate') or 0
            if total:
                on_progress(downloaded / total * 100)
        except (ValueError, ZeroDivisionError):
            pass
    return hook
