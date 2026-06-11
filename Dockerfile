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
# yt-dlp-ejs requires Node ≥ 22. Debian bookworm's apt nodejs is 18.x, too old
# (silently fails with "n challenge solving failed"), so we install Node 22
# from NodeSource. See https://github.com/yt-dlp/ejs.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get purge -y --auto-remove gnupg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt ./
RUN pip install -r requirements.txt

COPY backend/ ./
COPY --from=frontend-build /build/dist /app/frontend_dist

RUN mkdir -p /app/data \
    && useradd --create-home --uid 1000 --shell /usr/sbin/nologin ytdl \
    && chown -R ytdl:ytdl /app

# The SQLite DB (sessions, play history, catalog metadata) lives in /app/data.
# Back this path with persistent storage in Coolify (Service → Storage →
# add a volume mounted at /app/data), otherwise every redeploy starts empty:
# everyone gets logged out and daily-mix history resets.
VOLUME ["/app/data"]

USER ytdl

EXPOSE 9877

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS http://127.0.0.1:9877/api/auth/config || exit 1

CMD ["python", "main.py"]
