# syntax=docker/dockerfile:1.7

# ── Stage 1: build the SPA ────────────────────────────────────────────────────
FROM node:22-alpine AS frontend-build

WORKDIR /build

COPY frontend/package.json frontend/package-lock.json ./
# --legacy-peer-deps: @jofr/capacitor-media-session declares a Capacitor 6 peer
# but builds/runs on our Capacitor 8 (verified). Mirrors frontend/.npmrc, which
# isn't copied into this build stage.
RUN npm ci --legacy-peer-deps

COPY frontend/ ./
RUN npm run build


# ── Stage 2: backend runtime ──────────────────────────────────────────────────
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    YTDL_FRONTEND_DIST=/app/frontend_dist \
    PORT=9877

# Node.js is required by yt-dlp to solve YouTube's signature / n-param JS
# challenges via the yt-dlp-ejs plugin. Without a working JS runtime YouTube
# returns only image (storyboard) formats and any audio/video download fails
# with "Requested format is not available".
#
# yt-dlp-ejs requires Node ≥ 22 (bookworm's apt nodejs is 18.x, too old). Copy
# the Node 22 binary straight from the official image instead of piping
# NodeSource's install script into bash — no curl|bash supply-chain step and no
# third-party apt repo/key. Same Debian base (bookworm) as this stage, and the
# libstdc++6 the binary needs is pulled in by ffmpeg below. yt-dlp only needs the
# `node` runtime (not npm) to run the bundled challenge JS.
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt ./
RUN pip install -r requirements.txt

COPY backend/ ./
COPY --from=frontend-build /build/dist /app/frontend_dist

# Only the data volume needs to be writable by the runtime user; keep the app
# code + frontend dist root-owned (world-readable) so a runtime compromise can't
# overwrite the running code and persist across restarts.
RUN mkdir -p /app/data \
    && useradd --create-home --uid 1000 --shell /usr/sbin/nologin ytdl \
    && chown -R ytdl:ytdl /app/data

# The SQLite DB (sessions, play history, catalog metadata) lives in /app/data.
# Back this path with persistent storage in Coolify (Service → Storage →
# add a volume mounted at /app/data), otherwise every redeploy starts empty:
# everyone gets logged out and daily-mix history resets.
VOLUME ["/app/data"]

USER ytdl

EXPOSE 9877

# Probe with the Python already in the image (curl is no longer installed).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:9877/api/auth/config').status==200 else 1)"]

CMD ["python", "main.py"]
