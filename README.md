# ytDownloader

YouTube downloader with a vaporwave UI. FastAPI backend + React/Vite SPA, with
authentication delegated to [HomeAuth](http://localhost:8080) via the Backend
Gateway pattern (JWT never leaves the server).

## Layout

```
backend/     FastAPI on :8000 — yt-dlp + ffmpeg + SQLite queue + HomeAuth gateway
frontend/    Vite + React + TS + Tailwind v4 on :5273
scripts/     dev-up.sh / dev-down.sh
```

## Dev quick start

```bash
./scripts/dev-up.sh      # backend + frontend, idempotent
./scripts/dev-down.sh    # stop
```

Open <http://localhost:5273>. You will be redirected to `/login`.

## Configuration

The backend reads these env vars (defaults in parentheses):

| Variable | Purpose |
|---|---|
| `HOMEAUTH_BASE_URL` (`http://localhost:8080`) | Where HomeAuth lives. |
| `HOMEAUTH_APP_API_KEY` | **Required.** API key issued from the HomeAuth admin panel (`/admin/applications`). Only used server-to-server for `/auth/validate-token`. Never exposed to the browser. |
| `SESSION_COOKIE_NAME` (`ytdl_session`) | Cookie name issued by this backend to the browser. |
| `SESSION_COOKIE_SECURE` (`false`) | Set to `true` when serving over HTTPS. |
| `SESSION_COOKIE_SAMESITE` (`lax`) | `lax` (default) or `strict`. |
| `SESSION_TTL_DAYS` (`7`) | Lifetime of the cookie; refresh-cookie expiry on HomeAuth side matches. |
| `ACCESS_REFRESH_LEEWAY_SEC` (`60`) | Refresh the access token when it has less than this many seconds left. |
| `FRONTEND_ORIGIN` (`http://localhost:5273`) | CORS allow-list (single origin). |

Drop them in `backend/.env` and they will be picked up by `os.environ` when the
process starts (the dev script sources the venv but does not source `.env`
automatically — export them in your shell or use direnv).

## Auth flow (Backend Gateway)

```
[browser]
   │  POST /api/auth/login {usernameOrEmail, password}
   ▼
[ytdl backend]                                                 [HomeAuth]
   │  POST /auth/login (same body) ───────────────────────────►│
   │◄─── 200 {accessToken,...} + Set-Cookie: homeauth_refresh ─│
   │
   │  Stores in `sessions` table:
   │    {id, user_id, role, access_token, refresh_cookie, exp}
   │
   │  Set-Cookie: ytdl_session=<opaque>; HttpOnly; SameSite=Lax
   ▼
[browser]
```

On every protected request the backend reads `ytdl_session`, looks up the row,
and if the access token is close to expiry calls HomeAuth `/auth/refresh` with
the stored `homeauth_refresh` cookie. The browser never sees the JWT or the
HomeAuth refresh cookie.

## Authorization

- `ADMIN` sees every job in the queue/history.
- `USER` only sees jobs they created. Anyone other than the owner gets a 403 on
  GET/cancel/retry/delete of a specific job.
- `/api/resolutions` and `/ws/progress/*` are public. Everything else under
  `/api/` requires a valid session.

## Smoke test

A scripted end-to-end (login → list jobs → logout) lives at
[`scripts/auth-smoke.sh`](scripts/auth-smoke.sh). Invoke it with HomeAuth
credentials in env:

```bash
USERNAME=alice PASSWORD='...' ./scripts/auth-smoke.sh
```

## Deploy (Coolify self-hosted)

Single-image deploy. The root `Dockerfile` is multi-stage: it builds the SPA
with Node and bakes the static `dist/` into the FastAPI image, which then
serves the SPA from the same origin as `/api` and `/ws` (no CORS, no extra
service to route).

In Coolify:

1. **New Resource → Application → Public Repository** pointing at this repo.
2. **Build Pack:** Dockerfile. **Base Directory:** `/` (the root `Dockerfile`).
3. **Exposed Port:** `9877`. (HomeAuth lives on `:9876` in the same Coolify
   instance — this is the next port in the pair. Override with `PORT` env if
   needed.)
4. **Persistent Storage** (so the SQLite queue survives redeploys):
   - Mount path: `/app/data` → any host path or Coolify volume.
5. **Environment Variables** (everything that's not listed defaults sensibly):

   | Key | Example | Notes |
   |---|---|---|
   | `HOMEAUTH_BASE_URL` | `http://homeauth:8080` | Service name if HomeAuth lives in the same Coolify project network, otherwise the public HTTPS URL. |
   | `HOMEAUTH_APP_API_KEY` | `…` | API key from HomeAuth `/admin/applications`. |
   | `SESSION_COOKIE_SECURE` | `true` | Required once Traefik gives you HTTPS. |
   | `SESSION_COOKIE_SAMESITE` | `lax` | `strict` if you don't need cross-site embeds. |
   | `FRONTEND_ORIGIN` | *(leave empty)* | Same-origin in this topology; CORS disabled. |

6. **Health Check:** the image declares one on `GET /api/auth/config` (public).
   No extra config needed.

WebSocket (`/ws/progress/*`) works on Traefik out of the box since the path
prefix is enough to keep the upgrade headers. No special label required.

> SQLite lives at `/app/data/queue.db` inside the container (the schema is
> created on first boot). Mounting `/app/data` to a volume is what makes the
> queue persistent — without it, every redeploy starts with an empty history.

## Stack

- **Backend**: Python 3.12 + FastAPI + httpx + yt-dlp + ffmpeg + SQLite (WAL).
- **Frontend**: React 19 + Vite + TypeScript + Tailwind v4 + react-query.
- **Auth**: HomeAuth (external) via server-to-server JWT validation.
