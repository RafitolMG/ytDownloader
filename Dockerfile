# syntax=docker/dockerfile:1.7

# ── Stage 1: build the SPA ────────────────────────────────────────────────────
FROM node:22-alpine AS frontend-build

WORKDIR /build

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

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

# nodejs is required by yt-dlp to solve YouTube's signature / n-param JS
# challenges via the yt-dlp-ejs plugin. Without a JS runtime YouTube returns
# only image (storyboard) formats and any audio/video download fails with
# "Requested format is not available". Deno is yt-dlp's preferred runtime but
# Node is in apt and works equally well — see
# https://github.com/yt-dlp/yt-dlp/wiki/EJS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt ./
RUN pip install -r requirements.txt

COPY backend/ ./
COPY --from=frontend-build /build/dist /app/frontend_dist

RUN mkdir -p /app/data \
    && useradd --create-home --uid 1000 --shell /usr/sbin/nologin ytdl \
    && chown -R ytdl:ytdl /app

USER ytdl

EXPOSE 9877

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS http://127.0.0.1:9877/api/auth/config || exit 1

CMD ["python", "main.py"]
