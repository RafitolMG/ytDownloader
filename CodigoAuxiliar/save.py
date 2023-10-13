import os
import ffmpeg
from pytube import YouTube
from sys import argv

link = argv[1]
yt = YouTube(link, use_oauth=True, allow_oauth_cache=False)

video_resolutions = []
final_resolution = ""
for stream in yt.streams.order_by('resolution'):
    if not video_resolutions.__contains__(stream.resolution):
        video_resolutions.append(stream.resolution)  # Populating the resolution list

while True:
    # Looping through the video_resolutions list to be displayed on the screen for user selection...
    i = 1
    for resolution in video_resolutions:
        print(f'{i}. {resolution}')
        i += 1

    # To Download the video with the users Choice of resolution
    choice = int(input('\nChoose A Resolution Please: '))

    # To validate if the user enters a number displayed on the screen...
    if 1 <= choice < i:
        resolution_to_download = video_resolutions[choice - 1]
        print(f"You're now downloading the video with resolution {resolution_to_download}...")
        final_resolution = resolution_to_download
        break

    else:
        print("Invalid choice!!\n\n")

# Define output directory
output_directory = "D:/Youtube Videos/"

# Download audio only
if final_resolution == '1080p':
    audio = yt.streams.filter(abr="160kbps", progressive=False).first()
    audio_file_path = os.path.join(output_directory, "audio.mp3")
    audio.download(output_directory, filename="audio.mp3")

    # Download video only
    video = yt.streams.filter(res=final_resolution, progressive=False).first()
    video_file_path = os.path.join(output_directory, "video.mp4")
    video.download(output_directory, filename="video.mp4")

    # Merge audio and video
    title = yt.title
    audio_input = ffmpeg.input(audio_file_path)
    video_input = ffmpeg.input(video_file_path)
    output_file_path = os.path.join(output_directory, f"{title}.mp4")
    dl = ffmpeg.output(audio_input, video_input, output_file_path)

    ffmpeg.run(dl, overwrite_output=True)

    # Remove temporary files
    os.remove(audio_file_path)
    os.remove(video_file_path)

    print("Video download and merge completed!")
else:
    title = yt.title
    video = yt.streams.get_by_resolution(final_resolution)
    video.download(output_directory, filename=f"{title}.mp4")

    print("Video download!")
