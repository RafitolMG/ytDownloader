from tkinter import filedialog, messagebox
from io import BytesIO
from urllib.request import urlopen
import ttkbootstrap as ttk
from src import ytDownloaderFunctions
import os
import threading
from PIL import Image, ImageTk
from src import configFunctions

_QUALITY_OPTIONS = [
    ('Best Quality',      'best'),
    ('4K (2160p)',        '2160'),
    ('1440p',             '1440'),
    ('1080p',             '1080'),
    ('720p',              '720'),
    ('480p',              '480'),
    ('360p',              '360'),
    ('Audio Only (MP3)',  'audio'),
]
_QUALITY_LABELS  = [q[0] for q in _QUALITY_OPTIONS]
_QUALITY_BY_LABEL = {q[0]: q[1] for q in _QUALITY_OPTIONS}


class App(ttk.Window):
    def __init__(self, title, size, font):
        super().__init__(themename='darkly')
        self.title(title)
        self.geometry(f'{size[0]}x{size[1]}')
        self.minsize(size[0], size[1])
        self.maxsize(size[0], size[1])
        self.iconbitmap('Images/u327as.ico')

        self.s = ttk.Style()
        self.s.configure('.', font=(font, 12))

        self.format_code = None
        self.mode = 'single'  # 'single' | 'playlist'

        # --- URL bar ---
        res_frame = ttk.Frame(self)
        res_frame.place(relx=0.5, rely=0.1, anchor='center')
        self.url_entry = ttk.Entry(res_frame, width=80)
        self.url_entry.pack(side='left')
        ttk.Button(res_frame, text='Get Resolutions',
                   command=self._refresh_formats_async).pack(side='right', padx=5)

        # --- Single-video: Treeview ---
        columns = ('Resolution', 'Size', 'Extension', 'Format')
        self.resolutions = ttk.Treeview(
            self, columns=columns, show='headings', height=13,
            displaycolumns=('Resolution', 'Size', 'Extension'),
        )
        for col in ('Resolution', 'Size', 'Extension'):
            self.resolutions.heading(col, text=col)
            self.resolutions.column(col, anchor='center')
        self.resolutions.bind('<<TreeviewSelect>>', self._item_select)
        self.resolutions.place(relx=0.5, rely=0.35, anchor='center')

        # --- Playlist panel (hidden initially) ---
        self.playlist_frame = ttk.Frame(self, padding=20)
        self.playlist_title_label = ttk.Label(
            self.playlist_frame, text='', font=(font, 14, 'bold'),
            wraplength=600, justify='center')
        self.playlist_title_label.pack(pady=(0, 4))
        self.playlist_count_label = ttk.Label(self.playlist_frame, text='', font=(font, 11))
        self.playlist_count_label.pack(pady=(0, 14))
        quality_row = ttk.Frame(self.playlist_frame)
        quality_row.pack()
        ttk.Label(quality_row, text='Quality:').pack(side='left', padx=(0, 8))
        self.quality_var = ttk.StringVar(value='1080p')
        self.quality_combo = ttk.Combobox(
            quality_row, textvariable=self.quality_var,
            values=_QUALITY_LABELS, state='readonly', width=24)
        self.quality_combo.pack(side='left')

        # --- Thumbnail ---
        self.thumbnail_label = ttk.Label(self, border=0)
        self.thumbnail_label.place(relx=0.5, rely=0.7, anchor='center')

        # --- Per-video progress label (playlist mode) ---
        self.video_progress_label = ttk.Label(self, text='', font=(font, 10))
        self.video_progress_label.place(relx=0.5, rely=0.86, anchor='center')

        # --- Download bar ---
        downl_frame = ttk.Frame(self)
        downl_frame.place(relx=0.5, rely=0.9, anchor='n')
        self.progress_bar = ttk.Progressbar(downl_frame, length=300, mode='determinate')
        self.progress_bar.pack(pady=5)

        download_gif = Image.open('Images/descargar.png').resize((16, 16))
        download_gifTk = ImageTk.PhotoImage(download_gif)
        self.download_button = ttk.Button(
            downl_frame, text='Download', command=self._download_clicked,
            image=download_gifTk, compound='left')
        self.download_button.image = download_gifTk
        self.download_button.pack()

        # --- Output folder ---
        output_frame = ttk.Frame(self)
        output_frame.place(rely=0.93, relx=0.01)
        self.output_folder = ttk.StringVar(value=configFunctions.load_output_folder())
        ttk.Entry(output_frame, textvariable=self.output_folder,
                  state='readonly', font=font, width=30).pack(side='left', padx=5)
        choose_ico = Image.open('Images/agregar-carpeta.png').resize((32, 32))
        choose_icoTk = ImageTk.PhotoImage(choose_ico)
        choose_btn = ttk.Button(output_frame, command=self._choose_folder, image=choose_icoTk)
        choose_btn.image = choose_icoTk
        choose_btn.pack(side='right')

        self.mainloop()

    # ------------------------------------------------------------------ helpers

    def _choose_folder(self):
        folder = filedialog.askdirectory()
        if folder:
            self.output_folder.set(folder)
            configFunctions.save_output_folder(folder)

    def _item_select(self, _event):
        for i in self.resolutions.selection():
            self.format_code = self.resolutions.item(i)['values'][3]  # hidden Format column

    def _set_progress(self, percent):
        self.progress_bar['value'] = percent

    def _load_thumbnail(self, url):
        if not url:
            return
        try:
            with urlopen(url, timeout=5) as resp:
                data = resp.read()
            img = Image.open(BytesIO(data)).resize((320, 180))
            photo = ImageTk.PhotoImage(img)
            self.thumbnail_label.config(image=photo)
            self.thumbnail_label.image = photo
        except Exception:
            pass

    def _show_single_mode(self):
        self.mode = 'single'
        self.playlist_frame.place_forget()
        self.resolutions.place(relx=0.5, rely=0.35, anchor='center')
        self.video_progress_label.config(text='')

    def _show_playlist_mode(self, info):
        self.mode = 'playlist'
        self.resolutions.place_forget()
        self.playlist_title_label.config(text=info['title'])
        self.playlist_count_label.config(text=f"{info['count']} videos")
        self.playlist_frame.place(relx=0.5, rely=0.35, anchor='center')

    # ------------------------------------------------------------------ Get Resolutions

    def _refresh_formats_async(self):
        url = self.url_entry.get().strip()
        if not url:
            messagebox.showerror('Error', 'Please enter a URL')
            return
        threading.Thread(target=self._refresh_formats, args=(url,), daemon=True).start()

    def _refresh_formats(self, url):
        try:
            if ytDownloaderFunctions.is_playlist(url):
                info = ytDownloaderFunctions.get_playlist_info(url)
                self.after(0, lambda: self._show_playlist_mode(info))
                self.after(0, lambda: self._load_thumbnail(info['thumbnail_url']))
            else:
                data = ytDownloaderFunctions.get_available_resolutions(url)
                self.after(0, self._show_single_mode)
                self.after(0, lambda: self._populate_treeview(data['formats']))
                self.after(0, lambda: self._load_thumbnail(data['thumbnail_url']))
        except Exception as e:
            err = str(e)
            self.after(0, lambda: messagebox.showerror('Error', err))

    def _populate_treeview(self, formats):
        for row in self.resolutions.get_children():
            self.resolutions.delete(row)
        for fmt in formats:
            label = fmt['resolution'] + (' *' if fmt['needs_merge'] else '')
            self.resolutions.insert('', 'end', values=(
                label, fmt['size_display'], fmt['ext'], fmt['format_code'],
            ))

    # ------------------------------------------------------------------ Download

    def _download_clicked(self):
        self.download_button['state'] = 'disabled'
        url = self.url_entry.get().strip()
        if not url:
            messagebox.showerror('Error', "An URL hasn't been provided")
            self.download_button['state'] = 'enabled'
            return

        if self.mode == 'playlist':
            threading.Thread(target=self._download_playlist, args=(url,), daemon=True).start()
        else:
            if not self.format_code:
                messagebox.showerror('Error', 'Please select the desired format')
                self.download_button['state'] = 'enabled'
                return
            threading.Thread(target=self._download_single, args=(url,), daemon=True).start()

    def _download_single(self, url):
        try:
            output_folder = self.output_folder.get()
            video_filename, video_ext, audio_codec, total_frames = ytDownloaderFunctions.download_video(
                url, self.format_code, output_folder, self._set_progress)

            if audio_codec == 'none':
                audio_filename, audio_ext = ytDownloaderFunctions.download_audio(
                    url, output_folder, self._set_progress)
                base = os.path.splitext(os.path.basename(video_filename))[0]
                output_filename = os.path.join(output_folder, f'{base}_merged.mp4')
                ytDownloaderFunctions.merge_audio_video(
                    video_filename, audio_filename, output_filename, total_frames, self._set_progress)
                os.remove(video_filename)
                os.remove(audio_filename)
                self.after(0, lambda: messagebox.showinfo('Success', 'Video downloaded and merged successfully.'))
            else:
                self.after(0, lambda: messagebox.showinfo('Success', 'Video downloaded successfully.'))
        except Exception as e:
            err = str(e)
            self.after(0, lambda: messagebox.showerror('Error', err))
        finally:
            self.after(0, lambda: self.download_button.config(state='enabled'))

    def _download_playlist(self, url):
        try:
            quality = _QUALITY_BY_LABEL.get(self.quality_var.get(), 'best')
            output_folder = self.output_folder.get()

            def on_video(idx, total, title):
                self.after(0, lambda: self.video_progress_label.config(
                    text=f'Downloading {idx} / {total}: {title}'))
                self.after(0, lambda: self._set_progress(0))

            ytDownloaderFunctions.download_playlist(
                url, quality, output_folder,
                on_progress=self._set_progress,
                on_video_start=on_video,
            )
            self.after(0, lambda: self.video_progress_label.config(text=''))
            self.after(0, lambda: messagebox.showinfo('Success', 'Playlist downloaded successfully.'))
        except Exception as e:
            err = str(e)
            self.after(0, lambda: messagebox.showerror('Error', err))
        finally:
            self.after(0, lambda: self.download_button.config(state='enabled'))
