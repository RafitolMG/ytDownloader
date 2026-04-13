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


def _get_cookie_opts() -> dict:
    """
    Return yt-dlp options to authenticate with YouTube and avoid bot detection.

    Priority:
      1. cookies.txt file in project root (manual export via browser extension).
      2. Auto-detect an installed browser and extract cookies from it (Windows).
    Returns an empty dict if neither source is available.
    """
    cookies_file = os.path.join(_PROJECT_ROOT, 'cookies.txt')
    if os.path.isfile(cookies_file):
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

            formats.append({
                'format_code': yt_format['format_id'],
                'resolution': yt_format.get('resolution', 'Unknown'),
                'ext': yt_format.get('ext', 'Unknown'),
                'needs_merge': needs_merge,
                'size_display': size_display,
            })

    return {'formats': formats, 'thumbnail_url': thumbnail_url, 'ffmpeg_available': ffmpeg_available}


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


def download_playlist(url, quality, output_folder, on_progress=None, on_video_start=None):
    """
    Download all videos in a playlist.

    quality: 'best' | '2160' | '1440' | '1080' | '720' | '480' | '360' | 'audio'
    on_progress(percent)            — current video download progress 0-100
    on_video_start(index, total, title) — called when each new video starts
    """
    ffmpeg = _get_ffmpeg_path()

    _fmt = {
        'best':  'bestvideo[ext=mp4]+bestaudio/best',
        '2160':  'bestvideo[height<=2160][ext=mp4]+bestaudio/bestvideo[height<=2160]+bestaudio/best[height<=2160]',
        '1440':  'bestvideo[height<=1440][ext=mp4]+bestaudio/bestvideo[height<=1440]+bestaudio/best[height<=1440]',
        '1080':  'bestvideo[height<=1080][ext=mp4]+bestaudio/bestvideo[height<=1080]+bestaudio/best[height<=1080]',
        '720':   'bestvideo[height<=720][ext=mp4]+bestaudio/bestvideo[height<=720]+bestaudio/best[height<=720]',
        '480':   'bestvideo[height<=480][ext=mp4]+bestaudio/bestvideo[height<=480]+bestaudio/best[height<=480]',
        '360':   'bestvideo[height<=360][ext=mp4]+bestaudio/bestvideo[height<=360]+bestaudio/best[height<=360]',
        'audio': 'bestaudio/best',
    }
    fmt = _fmt.get(quality, _fmt['best'])

    postprocessors = []
    if quality == 'audio' and ffmpeg:
        postprocessors = [
            {'key': 'FFmpegExtractAudio', 'preferredcodec': 'mp3', 'preferredquality': '0'},
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
        if quality != 'audio':
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
