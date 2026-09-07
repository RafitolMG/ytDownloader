import { Capacitor, registerPlugin } from '@capacitor/core'

/** Native counterpart in android/.../FileSaverPlugin.java. */
type FileSaverPlugin = {
  downloadUrl(options: { url: string; filename: string }): Promise<{ filename: string }>
  saveText(options: {
    filename: string
    text: string
    mimeType?: string
  }): Promise<{ filename: string }>
}

const FileSaver = registerPlugin<FileSaverPlugin>('FileSaver')

/** True where a browser download can't work: in the APK the page origin is
 *  https://localhost, so an <a download> pointing at the backend's host is
 *  cross-origin and silently ignored — the file never lands anywhere. */
export const savesNatively = (): boolean => Capacitor.isNativePlatform()

/** Where a saved file ends up, for user-facing copy. */
export const SAVE_LOCATION = 'Downloads'

function anchorDownload(url: string, filename: string, revoke = false) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  if (revoke) URL.revokeObjectURL(url)
}

/** Save a server-hosted file to the device. Rejects with a usable message. */
export async function saveUrlToDevice(url: string, filename: string): Promise<void> {
  if (!savesNatively()) {
    // Programmatic anchor-click is more reliable than `window.location.href`:
    // setting `location.href` is treated as a navigation that the browser may
    // silently cancel (popup blockers, race with React re-renders, reverse
    // proxies that strip Content-Disposition).
    anchorDownload(url, filename)
    return
  }
  await FileSaver.downloadUrl({ url, filename })
}

/** Save text generated in the page (the playlist JSON export) to the device. */
export async function saveTextToDevice(
  filename: string,
  text: string,
  mimeType = 'application/octet-stream',
): Promise<void> {
  if (!savesNatively()) {
    const url = URL.createObjectURL(new Blob([text], { type: mimeType }))
    anchorDownload(url, filename, true)
    return
  }
  await FileSaver.saveText({ filename, text, mimeType })
}
