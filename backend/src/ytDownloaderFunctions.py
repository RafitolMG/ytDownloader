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


def _resolve_cookies_file() -> str | None:
    """Return the cookies.txt path to use, or None if no cookies are configured.

    Priority:
      1. YT_COOKIES_FILE env var (prod: typically a persistent volume in Coolify).
      2. cookies.txt in the project root (dev convenience).
    """
    env_path = os.environ.get('YT_COOKIES_FILE', '').strip()
    if env_path and os.path.isfile(env_path):
        return env_path
    legacy = os.path.join(_PROJECT_ROOT, 'cookies.txt')
    if os.path.isfile(legacy):
        return legacy
    return None


def _get_cookie_opts() -> dict:
    """
    Return yt-dlp options to authenticate with YouTube and avoid bot detection.

    Priority:
      1. cookies.txt resolved via _resolve_cookies_file.
      2. Auto-detect an installed browser and extract cookies from it (Windows).
    Returns an empty dict if neither source is available.
    """
    cookies_file = _resolve_cookies_file()
    if cookies_file:
        return {'cookiefile': cookies_file}

    if os.name == 'nt':
        # Chrome and Edge use app-bound encryption since v127 which breaks DPAPI
        # extraction from outside the browser process. Firefox still works fine.
        appdata = os.environ.get('APPDATA', '')
        firefox_dir = os.path.join(appdata, 'Mozilla', 'Firefox', 'Profiles')
        if os.path.isdir(firefox_dir):
            return {'cookiesfrombrowser': ('firefox',)}

    return {}


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

    return {'formats': formats, 'thumbnail_url': thumbnail_url, 'ffmpeg_available': ffmpeg_available}


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
        tracks.append({
            'id': vid,
            'title': e.get('title') or vid,
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
    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'skip_download': True,
        **_get_cookie_opts(),
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)
    vid = info.get('id')
    if not vid:
        raise RuntimeError("yt-dlp returned no video id for this URL")
    duration = info.get('duration')
    return {
        'id': vid,
        'title': info.get('title') or vid,
        'uploader': info.get('uploader'),
        'duration_sec': int(duration) if duration else None,
        'thumbnail': info.get('thumbnail'),
        'webpage_url': info.get('webpage_url') or url,
    }


def is_audio_quality(format_code: str) -> bool:
    """Return True if `format_code` matches an audio-quality preset alias."""
    return format_code in _AUDIO_QUALITIES


def download_track_audio(url, codec, bitrate, dest_path, on_progress=None):
    """
    Download a single video as audio with the given codec+bitrate, writing the
    final post-processed file to `dest_path`. Creates parent dirs as needed.

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
            ydl.download([url])

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
        return dest_path
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


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
