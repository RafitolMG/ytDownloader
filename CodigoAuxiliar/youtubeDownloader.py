import yt_dlp
import sys
import os


def download_video(url, format_code):
    ydl_opts = {
        'format': format_code,
        'outtmpl': 'D:/Youtube Videos/%(title)s.%(ext)s',
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
        'outtmpl': 'D:/Youtube Videos/%(title)s_audio.%(ext)s',
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

        print("\nAvailable Resolutions:\n")
        for format in formats:
            if format.get('vcodec') == 'none':
                continue  # Skip audio-only formats

            format_code = format['format_id']
            resolution = format.get('resolution', 'Unknown')
            ext = format.get('ext', 'Unknown')
            acodec = format.get('acodec', 'Unknown')
            size = format.get('filesize', 'Unknown')
            print(
                f"Format Code: {format_code}, Resolution: {resolution}, Extension: {ext}, AudioCodec: {acodec}, FileSize: {size}")


# Check if a video URL was provided
if len(sys.argv) < 2:
    print("Please provide the URL of the video to download.")
    sys.exit(1)

# Get the video URL from the command-line argument
video_url = sys.argv[1]

# Display available resolutions
get_available_resolutions(video_url)

# Prompt the user to choose a format code
chosen_format = input("Enter the format code for the desired resolution: ")

# Call the download_video function with the provided URL and chosen format
video_filename, video_ext, audio_codec = download_video(video_url, chosen_format)

# Check if the video extension is not '.mp4'
if audio_codec == 'none':
    # Download the best audio possible
    audio_filename, audio_ext = download_audio(video_url)

    # Merge audio and video into a single file
    video_info = yt_dlp.YoutubeDL().extract_info(video_url, download=False)
    output_filename = f"D:/Youtube Videos/video_merged.mp4"
    merge_audio_video(video_filename, audio_filename, output_filename)

    # Remove the separate audio and video files
    os.remove(video_filename)
    os.remove(audio_filename)

    print("Video downloaded and merged with audio successfully.")
else:
    print("Video downloaded successfully.")
