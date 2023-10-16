import tkinter as tk
from tkinter import messagebox
from tkinter import filedialog
import yt_dlp
import os


def download_video(url, format_code):
    ydl_opts = {
        'format': format_code,
        'outtmpl': os.path.join(output_folder.get(), '%(title)s.%(ext)s'),
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        result = ydl.extract_info(url, download=True)
        video_filename = ydl.prepare_filename(result)
        video_ext = result['ext']
        audio_codec = result['acodec']

    return video_filename, video_ext, audio_codec


def download_audio(url):
    ydl_opts = {
        'format': 'bestaudio/best',
        'outtmpl': os.path.join(output_folder.get(), '%(title)s_audio.%(ext)s'),
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        result = ydl.extract_info(url, download=True)
        audio_filename = ydl.prepare_filename(result)
        audio_ext = result['ext']

    return audio_filename, audio_ext


def merge_audio_video(video_file, audio_file, output_file):
    command = f'ffmpeg -i "{video_file}" -i "{audio_file}" -c:v copy -c:a aac -strict experimental "{output_file}"'
    os.system(command)


def get_available_resolutions(url):
    ydl_opts = {
        'listformats': True,
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)
        formats = info.get('formats', [])

        resolutions_text.delete('1.0', tk.END)
        resolutions_text.insert(tk.END, "Available Resolutions:\n\n")
        for format in formats:
            if format.get('vcodec') == 'none':
                continue  # Skip audio-only formats

            format_code = format['format_id']
            resolution = format.get('resolution', 'Unknown')
            ext = format.get('ext', 'Unknown')
            acodec = format.get('acodec', 'Unknown')
            size = format.get('filesize', 'Unknown')
            resolutions_text.insert(tk.END, f"Format Code: {format_code}, Resolution: {resolution}, Extension: {ext}, AudioCodec: {acodec}, FileSize: {size}\n")


def download_button_clicked():
    video_url = url_entry.get().strip()

    if not video_url:
        messagebox.showerror("Error", "Please provide the URL of the video to download.")
        return

    chosen_format = format_entry.get().strip()

    if not chosen_format:
        messagebox.showerror("Error", "Please enter the format code for the desired resolution.")
        return

    try:
        video_filename, video_ext, audio_codec = download_video(video_url, chosen_format)

        if audio_codec == 'none':
            audio_filename, audio_ext = download_audio(video_url)

            output_filename = os.path.join(output_folder.get(), 'video_merged.mp4')
            merge_audio_video(video_filename, audio_filename, output_filename)

            os.remove(video_filename)
            os.remove(audio_filename)

            messagebox.showinfo("Success", "Video downloaded and merged with audio successfully.")
        else:
            messagebox.showinfo("Success", "Video downloaded successfully.")
    except Exception as e:
        messagebox.showerror("Error", str(e))


def choose_folder_clicked():
    folder_selected = filedialog.askdirectory()

    if folder_selected:
        output_folder.set(folder_selected)


# Create the main window
window = tk.Tk()
window.title("YouTube Video Downloader")
window.geometry("500x400")

# Create and position the widgets
url_label = tk.Label(window, text="Video URL:")
url_label.pack()

url_entry = tk.Entry(window, width=50)
url_entry.pack()

format_label = tk.Label(window, text="Format Code:")
format_label.pack()

format_entry = tk.Entry(window, width=50)
format_entry.pack()

output_folder_label = tk.Label(window, text="Output Folder:")
output_folder_label.pack()

output_folder = tk.StringVar()
output_folder_entry = tk.Entry(window, textvariable=output_folder, width=40, state="readonly")
output_folder_entry.pack(side=tk.LEFT)

choose_folder_button = tk.Button(window, text="Choose Folder", command=choose_folder_clicked)
choose_folder_button.pack(side=tk.LEFT)

resolutions_text = tk.Text(window, height=10, width=60)
resolutions_text.pack()

get_resolutions_button = tk.Button(window, text="Get Resolutions", command=lambda: get_available_resolutions(url_entry.get().strip()))
get_resolutions_button.pack()

download_button = tk.Button(window, text="Download", command=download_button_clicked)
download_button.pack()

# Start the main loop
window.mainloop()
