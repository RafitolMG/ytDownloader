import tkinter as tk
from tkinter import messagebox
from PIL import Image, ImageTk
import io
import yt_dlp
import os
import subprocess
import re
from urllib.request import urlopen


def download_video(url, format_code, output_folder, progress_bar):
    ydl_opts = {
        'format': format_code,
        'outtmpl': os.path.join(output_folder.get(), '%(title)s.%(ext)s'),
        'progress_hooks': [progress_hook(progress_bar)]
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        result = ydl.extract_info(url, download=True)
        video_filename = ydl.prepare_filename(result)
        video_ext = result['ext']
        audio_codec = result['acodec']
        duration = float(result['duration'])
        fps = float(result['fps'])

    return video_filename, video_ext, audio_codec, calculate_total_frames(duration, fps)


def calculate_total_frames(duration, fps):
    total_frames = int(duration * fps)
    return total_frames


def download_audio(url, output_folder, progress_bar):
    ydl_opts = {
        'format': 'bestaudio/best',
        'outtmpl': os.path.join(output_folder.get(), '%(title)s_audio.%(ext)s'),
        'progress_hooks': [progress_hook(progress_bar)]
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        result = ydl.extract_info(url, download=True)
        audio_filename = ydl.prepare_filename(result)
        audio_ext = result['ext']

    return audio_filename, audio_ext


def merge_audio_video(video_file, audio_file, output_file, video_frames, progress_bar):
    cmd = [
        'ffmpeg',
        '-i', video_file,
        '-i', audio_file,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-strict', 'experimental',
        output_file
    ]

    try:
        # Start the ffmpeg process and capture its output for real time progress bar
        process = subprocess.Popen(cmd, stderr=subprocess.PIPE, universal_newlines=True)

        # Define a regex pattern to extract progress information
        progress_pattern = re.compile(r"frame=(\s*\d+)")

        while True:
            line = process.stderr.readline()
            if not line:
                break
            match = progress_pattern.search(line)
            if match:
                frame_number = int(match.group(1))
                total_frames = video_frames  # You can adjust this based on your video's total frames
                progress_percent = (frame_number / total_frames) * 100
                progress_bar['value'] = progress_percent

        process.communicate()  # Wait for the process to finish
        if process.returncode != 0:
            print("Error: FFmpeg process returned a non-zero exit code.")
    except subprocess.CalledProcessError as e:
        print("Error:", e)


def get_available_resolutions(url, resolutions_treeview, thumbnail_label):
    try:
        ydl_opts = {
            'listformats': True,
        }

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)

            # Fetch the video thumbnail URL
            thumbnail_url = info.get('thumbnail')

            # Read the thumbnail url
            if thumbnail_url:
                thumbnail_image = Image.open(io.BytesIO(urlopen(thumbnail_url).read()))
                thumbnail_image.thumbnail((1280 / 2.5, 720 / 2.5))
                thumbnail_imageTK = ImageTk.PhotoImage(thumbnail_image)

                # Display the image in a Label
                thumbnail_label.config(image=thumbnail_imageTK)
                thumbnail_label.image = thumbnail_imageTK

            # Fetch all formats of the video
            formats = info.get('formats', [])

            # List all the formats of the video
            for yt_format in formats:
                if yt_format.get('vcodec') == 'none' or yt_format.get('filesize') is None:
                    continue  # Skip audio-only formats

                format_code = yt_format['format_id']  # Format id for input into download function
                resolution = yt_format.get('resolution', 'Unknown')  # resolution of the video
                ext = yt_format.get('ext', 'Unknown')  # video extension
                acodec = yt_format.get('acodec')  # audio_codec of the video
                size = yt_format.get('filesize')  # file size

                # if the format not webm or mp4 skip
                if ext != 'mp4':  # if ext not in ('webm', 'mp4'): If we want webm also
                    continue

                # change response for better view in treeview
                if acodec == 'none':
                    acodec = 'Yes'
                else:
                    acodec = 'No'

                # change size from b to Mb
                size_mb = float(size) / (1024 * 1024)
                if size_mb >= 1024:
                    size_gb = float(size_mb) / 1024
                    size_display = f'{size_gb:.2f} Gb'
                else:
                    size_display = f'{size_mb:.2f} Mb'

                # insert the resolutions in the treeview
                resolutions_treeview.insert(parent='', index=tk.END,
                                            values=(resolution, size_display, ext,acodec, format_code))

    except Exception as e:
        messagebox.showerror("Error", f'{e}')


def delete_and_get_resolutions(url, resolutions_treeview, thumbnail_label):
    for i in resolutions_treeview.get_children():
        resolutions_treeview.delete(i)
    get_available_resolutions(url, resolutions_treeview, thumbnail_label)


def progress_hook(progress_bar):
    def update_progress_bar(d):
        if d['status'] == 'downloading':
            progress_percent = float(d['_percent_str'].strip('%'))
            progress_bar['value'] = progress_percent
        else:
            progress_bar['value'] = 0

    return update_progress_bar
