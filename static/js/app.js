/* ── State ────────────────────────────────────────────────────────────────── */
let selectedFormatCode = null;

/* ── DOM refs ─────────────────────────────────────────────────────────────── */
const urlInput          = document.getElementById('url-input');
const formatsBody       = document.getElementById('formats-body');
const thumbnail         = document.getElementById('thumbnail');
const thumbnailPH       = document.getElementById('thumbnail-placeholder');
const progressBar       = document.getElementById('progress-bar');
const progressLabel     = document.getElementById('progress-label');
const statusMessage     = document.getElementById('status-message');
const downloadBtn       = document.getElementById('download-btn');
const getResolutionsBtn = document.getElementById('get-resolutions-btn');

/* ── Init ─────────────────────────────────────────────────────────────────── */
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') getResolutions();
});

/* ── Get formats ──────────────────────────────────────────────────────────── */
async function getResolutions() {
  const url = urlInput.value.trim();
  if (!url) return setStatus('Please paste a YouTube URL first.', 'error');

  setStatus('Fetching formats…');
  selectedFormatCode = null;
  clearTable();
  hideThumbnail();
  getResolutionsBtn.disabled = true;

  try {
    const res = await fetch('/api/resolutions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    if (!res.ok) {
      const err = await res.json();
      return setStatus(err.detail || 'Failed to fetch formats.', 'error');
    }

    const data = await res.json();
    populateTable(data.formats);
    showThumbnail(data.thumbnail_url);
    if (!data.ffmpeg_available) {
      setStatus('FFmpeg not found — only formats with built-in audio are shown. Install FFmpeg to unlock higher resolutions.', 'error');
    } else {
      setStatus('');
    }
  } catch (e) {
    setStatus('Network error: ' + e.message, 'error');
  } finally {
    getResolutionsBtn.disabled = false;
  }
}

function populateTable(formats) {
  if (!formats || formats.length === 0) {
    clearTable('No MP4 formats found for this URL.');
    return;
  }

  formatsBody.innerHTML = '';
  formats.forEach((fmt) => {
    const tr = document.createElement('tr');
    tr.dataset.code = fmt.format_code;
    tr.innerHTML = `
      <td>${fmt.resolution}</td>
      <td>${fmt.size_display}</td>
      <td>${fmt.ext}</td>
      <td>${fmt.needs_merge
        ? '<span class="badge badge-warning">FFmpeg</span>'
        : '<span class="badge badge-ok">Direct</span>'
      }</td>
    `;
    tr.addEventListener('click', () => selectRow(tr, fmt.format_code));
    formatsBody.appendChild(tr);
  });
}

function selectRow(row, code) {
  document.querySelectorAll('#formats-body tr').forEach((r) => r.classList.remove('selected'));
  row.classList.add('selected');
  selectedFormatCode = code;
  setStatus('');
}

function clearTable(message = 'No formats loaded yet. Paste a URL and click Get Formats.') {
  formatsBody.innerHTML = `<tr class="empty-row"><td colspan="4">${message}</td></tr>`;
}

/* ── Thumbnail ────────────────────────────────────────────────────────────── */
function showThumbnail(url) {
  if (!url) return;
  thumbnail.src = url;
  thumbnail.hidden = false;
  thumbnailPH.hidden = true;
}

function hideThumbnail() {
  thumbnail.src = '';
  thumbnail.hidden = true;
  thumbnailPH.hidden = false;
}

/* ── Download ─────────────────────────────────────────────────────────────── */
async function startDownload() {
  const url = urlInput.value.trim();
  if (!url)                return setStatus('Please paste a YouTube URL.', 'error');
  if (!selectedFormatCode) return setStatus('Please select a format from the table.', 'error');

  downloadBtn.disabled = true;
  setProgress(0);
  setStatus('Starting download…');

  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, format_code: selectedFormatCode }),
    });

    if (!res.ok) {
      const err = await res.json();
      setStatus(err.detail || 'Failed to start download.', 'error');
      downloadBtn.disabled = false;
      return;
    }

    const { job_id } = await res.json();
    listenProgress(job_id);
  } catch (e) {
    setStatus('Network error: ' + e.message, 'error');
    downloadBtn.disabled = false;
  }
}

function listenProgress(jobId) {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${protocol}://${location.host}/ws/progress/${jobId}`);
  let finished = false;

  ws.onmessage = (e) => {
    const event = JSON.parse(e.data);

    if (event.type === 'progress') {
      setProgress(event.value);
      setStatus(`Downloading… ${event.value}%`);
    } else if (event.type === 'done') {
      finished = true;
      setProgress(100);
      setStatus('Done! Your download will start shortly.', 'success');
      triggerBrowserDownload(jobId, event.filename);
      downloadBtn.disabled = false;
      ws.close();
    } else if (event.type === 'error') {
      finished = true;
      setStatus('Error: ' + event.message, 'error');
      downloadBtn.disabled = false;
      ws.close();
    }
  };

  ws.onerror = () => {
    if (!finished) {
      setStatus('WebSocket connection lost.', 'error');
      downloadBtn.disabled = false;
    }
  };
}

async function triggerBrowserDownload(jobId, filename) {
  const fileUrl = `/api/file/${jobId}`;

  // Chrome/Edge: show native "Save As" dialog so the user picks the folder
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename || 'video.mp4',
        types: [{ description: 'MP4 Video', accept: { 'video/mp4': ['.mp4'] } }],
      });
      const response = await fetch(fileUrl);
      const writable = await handle.createWritable();
      await response.body.pipeTo(writable);
      return;
    } catch (e) {
      if (e.name === 'AbortError') {
        setStatus('Download cancelled.', 'error');
        return;
      }
      // Any other error: fall through to default download
    }
  }

  // Fallback for Firefox/Safari: standard browser download
  const a = document.createElement('a');
  a.href = fileUrl;
  a.download = filename || 'video.mp4';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */
function setProgress(value) {
  const pct = Math.min(100, Math.max(0, value));
  progressBar.style.width = pct + '%';
  progressLabel.textContent = Math.round(pct) + '%';
}

function setStatus(message, type = '') {
  statusMessage.textContent = message;
  statusMessage.className = 'status-message' + (type ? ' ' + type : '');
}
