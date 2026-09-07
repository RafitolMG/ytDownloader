package com.rafitol.ytdownloader;

import android.app.DownloadManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Saves a file to the device's public Downloads folder.
 *
 * The WebView cannot do this on its own: the page is served from
 * https://localhost while files come from the backend's own host, so the
 * `download` attribute on an anchor is cross-origin and ignored, and a blob URL
 * has nothing to hand the system either. DownloadManager (for a URL) and
 * MediaStore (for content we generate) are the two paths that work under scoped
 * storage without requesting a permission on any API level this app supports.
 */
@CapacitorPlugin(name = "FileSaver")
public class FileSaverPlugin extends Plugin {

    /** Hand a URL to the system download manager — it shows its own progress
     *  notification and writes into the public Downloads collection. */
    @PluginMethod
    public void downloadUrl(PluginCall call) {
        String url = call.getString("url");
        String filename = call.getString("filename");
        if (url == null || url.isEmpty() || filename == null || filename.isEmpty()) {
            call.reject("url and filename are required");
            return;
        }
        try {
            DownloadManager manager =
                    (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager == null) {
                call.reject("this device has no download manager");
                return;
            }
            String name = sanitize(filename);
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setTitle(name);
            request.setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            manager.enqueue(request);

            JSObject result = new JSObject();
            result.put("filename", name);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("could not start the download: " + e.getMessage(), e);
        }
    }

    /** Write text we generated in the WebView (the playlist JSON export) into
     *  the same Downloads folder. */
    @PluginMethod
    public void saveText(PluginCall call) {
        String filename = call.getString("filename");
        String text = call.getString("text");
        String mimeType = call.getString("mimeType", "application/octet-stream");
        if (filename == null || filename.isEmpty() || text == null) {
            call.reject("filename and text are required");
            return;
        }
        String name = sanitize(filename);
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                writeViaMediaStore(name, mimeType, bytes);
            } else {
                writeViaFile(name, bytes);
            }
            JSObject result = new JSObject();
            result.put("filename", name);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("could not save the file: " + e.getMessage(), e);
        }
    }

    private void writeViaMediaStore(String name, String mimeType, byte[] bytes) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, name);
        values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
        // Keep it hidden from other apps until the bytes are on disk.
        values.put(MediaStore.Downloads.IS_PENDING, 1);

        Uri item = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (item == null) {
            throw new IOException("the downloads collection rejected the file");
        }
        try (OutputStream out = resolver.openOutputStream(item)) {
            if (out == null) {
                throw new IOException("could not open the file for writing");
            }
            out.write(bytes);
        }
        values.clear();
        values.put(MediaStore.Downloads.IS_PENDING, 0);
        resolver.update(item, values, null, null);
    }

    private void writeViaFile(String name, byte[] bytes) throws IOException {
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IOException("could not open the downloads folder");
        }
        try (FileOutputStream out = new FileOutputStream(new File(dir, name))) {
            out.write(bytes);
        }
    }

    /** Reduce a server-supplied name to one safe path segment. */
    private static String sanitize(String name) {
        String base = name.replaceAll("[\\\\/:*?\"<>|\\r\\n]+", "_").trim();
        while (base.startsWith(".")) {
            base = base.substring(1);
        }
        if (base.isEmpty()) {
            base = "download";
        }
        return base.length() > 120 ? base.substring(0, 120) : base;
    }
}
