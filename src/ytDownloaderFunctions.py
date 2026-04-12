import shutil
import yt_dlp
import os
import subprocess
import re

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_LOCAL_FFMPEG = os.path.join(_PROJECT_ROOT, 'bin', 'ffmpeg.exe' if os.name == 'nt' else 'ffmpeg')


def _get_ffmpeg_path():
    """Return path to ffmpeg: local bin/ folder first, then system PATH."""
    if os.path.isfile(_LOCAL_FFMPEG):
        return _LOCAL_FFMPEG
    return shutil.which('ffmpeg')


def download_video(url, format_code, output_folder, on_progress=None):
    ydl_opts = {
        'format': format_code,
        'outtmpl': os.path.join(output_folder, '%(title)s.%(ext)s'),
        'progress_hooks': [_progress_hook(on_progress)]
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        result = ydl.extract_info(url, download=True)
        video_filename = ydl.prepare_filename(result)
        video_ext = result['ext']
        audio_codec = result['acodec']
        duration = float(result['duration'])
        fps = float(result['fps'])

    return video_filename, video_ext, audio_codec, _calculate_total_frames(duration, fps)


def download_audio(url, output_folder, on_progress=None):
    ydl_opts = {
        'format': 'bestaudio/best',
        'outtmpl': os.path.join(output_folder, '%(title)s_audio.%(ext)s'),
        'progress_hooks': [_progress_hook(on_progress)]
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        result = ydl.extract_info(url, download=True)
        audio_filename = ydl.prepare_filename(result)
        audio_ext = result['ext']

    return audio_filename, audio_ext


def merge_audio_video(video_file, audio_file, output_file, video_frames, on_progress=None):
    ffmpeg = _get_ffmpeg_path()
    if ffmpeg is None:
        raise RuntimeError("FFmpeg not found. Place ffmpeg.exe in the bin/ folder or add it to your PATH.")

    cmd = [
        ffmpeg,
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


def get_available_resolutions(url):
    """
    Returns a dict with:
      - 'formats': list of dicts with keys: format_code, resolution, ext, needs_merge, size_display
      - 'thumbnail_url': str or None
      - 'ffmpeg_available': bool
    Raises on error.
    """
    ydl_opts = {'quiet': True, 'no_warnings': True}

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)

    thumbnail_url = info.get('thumbnail')
    ffmpeg_available = _get_ffmpeg_path() is not None
    formats = []

    for yt_format in info.get('formats', []):
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


def _calculate_total_frames(duration, fps):
    return int(duration * fps)


def _progress_hook(on_progress):
    def hook(d):
        if on_progress is None:
            return
        if d['status'] == 'downloading':
            try:
                percent = float(d['_percent_str'].strip('%'))
                on_progress(percent)
            except (ValueError, KeyError):
                pass
    return hook
