import tkinter as tk
from tkinter import messagebox
from tkinter import filedialog
import yt_dlp
import os


def download_video(url, format_code,output_folder,progress_bar):
    ydl_opts = {
        'format': format_code,
        'outtmpl': os.path.join(output_folder.get(), '%(title)s.%(ext)s'),
        'progress_hooks':[progress_hook(progress_bar)]
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        result = ydl.extract_info(url, download=True)
        video_filename = ydl.prepare_filename(result)
        video_ext = result['ext']
        audio_codec = result['acodec']

    return video_filename, video_ext, audio_codec


def download_audio(url,output_folder,progress_bar):
    ydl_opts = {
        'format': 'bestaudio/best',
        'outtmpl': os.path.join(output_folder.get(), '%(title)s_audio.%(ext)s'),
        'progress_hooks':[progress_hook(progress_bar)]
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        result = ydl.extract_info(url, download=True)
        audio_filename = ydl.prepare_filename(result)
        audio_ext = result['ext']

    return audio_filename, audio_ext


def merge_audio_video(video_file, audio_file, output_file):
    command = f'ffmpeg -i "{video_file}" -i "{audio_file}" -c:v copy -c:a aac -strict experimental "{output_file}"'
    os.system(command)

def get_available_resolutions(url,resolutions_text):
    try:
        ydl_opts = {
            'listformats': True,
        }

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            formats = info.get('formats', [])

            for format in formats:
                if format.get('vcodec') == 'none' or format.get('filesize') is None:
                    continue  # Skip audio-only formats

                format_code = format['format_id']
                resolution = format.get('resolution', 'Unknown')
                ext = format.get('ext', 'Unknown')
                acodec = format.get('acodec')
                size = format.get('filesize')

                if ext not in ('webm','mp4'):
                    continue

                if acodec == 'none':
                    acodec = 'Yes'
                else:
                    acodec='No'

                size_mb = float(size) / (1024 * 1024)
                size_display = f'{size_mb:.2f} MB'

                resolutions_text.insert(parent='',index=tk.END,values=(resolution,size_display,ext,acodec,format_code))

    except Exception as e:
        messagebox.showerror("Error",'No URL or not valid')

def progress_hook(progress_bar):
    def update_progress_bar(d):
        if d['status'] == 'downloading':
            progress_percent = float(d['_percent_str'].strip('%'))
            progress_bar['value']=progress_percent
        else:
            progress_bar['value']=0

    return update_progress_bar


