from tkinter import filedialog
from tkinter import messagebox
import ttkbootstrap as ttk
from src import ytDownloaderFunctions
import os
import threading
from PIL import Image, ImageTk
from src import configFunctions


class App(ttk.Window):
    def __init__(self, title, size, font):
        # main setup
        super().__init__(themename='darkly')
        self.title(title)
        self.geometry(f'{size[0]}x{size[1]}')
        self.minsize(size[0], size[1])
        self.maxsize(size[0], size[1])
        self.iconbitmap('Images/AlienFumon.jpg')

        self.s = ttk.Style()
        self.s.configure('.', font=(font, 12))

        # widgets

        # link frame
        res_frame = ttk.Frame()
        res_frame.place(relx=0.5, rely=0.1, anchor='center')
        self.url_entry = ttk.Entry(res_frame, width=80)
        self.url_entry.pack(side='left')

        get_resolutions_button = ttk.Button(res_frame, text='Get Resolutions',
                                            command=lambda: ytDownloaderFunctions.delete_and_get_resolutions(
                                                self.url_entry.get().strip(), self.resolutions, self.thumbnail_label))

        get_resolutions_button.pack(side='right', padx=5)

        # resolutions viewer
        columns = ('Resolution', 'Size', 'Extension', 'Merge?')
        self.resolutions = ttk.Treeview(self, columns=columns, show='headings',height=13 )
        for col in columns:
            self.resolutions.heading(col, text=col)
            self.resolutions.column(col, anchor='center')

        self.resolutions.bind('<<TreeviewSelect>>', self.item_select)
        self.resolutions.place(relx=0.5, rely=0.32, anchor='center',)
        self.format_code = None

        # thumbnail
        self.thumbnail_label = ttk.Label(border=0, )
        self.thumbnail_label.place(relx=0.5, rely=0.695, anchor='center')

        # download frame
        downl_frame = ttk.Frame()
        downl_frame.place(relx=0.5, rely=0.9, anchor='n')
        self.progress_bar = ttk.Progressbar(downl_frame, length=300, mode='determinate')
        self.progress_bar.pack(pady=5)

        download_gif = Image.open('Images/descargar.png').resize((16, 16))
        download_gifTk = ImageTk.PhotoImage(download_gif)

        self.download_button = ttk.Button(downl_frame, text='Download', bootstyle='success',
                                          command=self.download_button_clicked, state='enabled', image=download_gifTk,
                                          compound='left')
        self.download_button.pack()

        # outuput frame
        output_frame = ttk.Frame()
        output_frame.place(rely=0.9, relx=0)
        self.output_folder = ttk.StringVar()
        initial_output_folder = configFunctions.load_output_folder()
        self.output_folder.set(initial_output_folder)
        output_folder_entry = ttk.Entry(output_frame, textvariable=self.output_folder, state='readonly', font=font,
                                        width=30)
        output_folder_entry.pack(side='left', padx=5)

        choose_folder_ico = Image.open('Images/agregar-carpeta.png').resize((16, 16))
        choose_folder_icoTk = ImageTk.PhotoImage(choose_folder_ico)
        choose_folder_button = ttk.Button(output_frame, text='Choose Folder', command=self.choose_folder,
                                          image=choose_folder_icoTk)
        choose_folder_button.pack(side='right')

        # run
        self.mainloop()

    def choose_folder(self):
        folder_selected = filedialog.askdirectory()

        if folder_selected:
            self.output_folder.set(folder_selected)
            configFunctions.save_output_folder(folder_selected)

    def item_select(self, event):
        for i in self.resolutions.selection():
            self.format_code = self.resolutions.item(i)['values'][-1]

    def download_button_clicked(self):
        self.download_button['state'] = 'disabled'
        video_url = self.url_entry.get().strip()
        if not video_url:
            messagebox.showerror("Error", "An URL hasn't been provided")
            self.download_button['state'] = 'enabled'
            return

        chosen_format = f'{self.format_code}'

        if chosen_format is None:
            messagebox.showerror("Error", "Please select the desired format")
            self.download_button['state'] = 'enabled'
            return

        def download_proccess():
            try:
                video_filename, video_ext, audio_codec, total_frames = ytDownloaderFunctions.download_video(video_url,
                                                                                                            chosen_format,
                                                                                                            self.output_folder,
                                                                                                            self.progress_bar)

                if audio_codec == 'none':
                    audio_filename, audio_ext = ytDownloaderFunctions.download_audio(video_url, self.output_folder,
                                                                                     self.progress_bar)

                    output_filename = os.path.join(self.output_folder.get(),
                                                   f'{video_filename.split(".")[0]}_merged.mp4')
                    ytDownloaderFunctions.merge_audio_video(video_filename, audio_filename, output_filename,
                                                            total_frames, self.progress_bar)

                    os.remove(video_filename)
                    os.remove(audio_filename)

                    messagebox.showinfo("Success", "Video downloaded and merged with audio successfully.")
                    self.download_button['state'] = 'enabled'
                else:
                    messagebox.showinfo("Success", "Video downloaded successfully.")
                    self.download_button['state'] = 'enabled'
            except Exception as e:
                messagebox.showerror("Error", str(e))
                self.download_button['state'] = 'enabled'

        download_thread = threading.Thread(target=download_proccess)
        download_thread.start()
