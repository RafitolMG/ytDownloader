# Coolify cleanup — wipe downloads & library

Quick reference for resetting the ytDownloader DB and physical audio files on
the Coolify deployment. SQLite lives at `/app/data/queue.db` inside the
container; library files at `/app/data/library/{video_id}/...`.

`sessions` is preserved (so your browser stays logged in). Schema is recreated
at next startup by `db.init()`.

## Run in Coolify Terminal (or `docker exec` from the host)

### 1. Wipe DB tables + library files

```bash
python -c "import sqlite3,shutil,os;D='/app/data/queue.db';L='/app/data/library';c=sqlite3.connect(D);[c.execute(f'DELETE FROM {t}') for t in ('track_owners','tracks','jobs')];c.commit();c.execute('VACUUM');c.close();[shutil.rmtree(os.path.join(L,e)) for e in (os.listdir(L) if os.path.isdir(L) else []) if os.path.isdir(os.path.join(L,e))];print('done')"
```

### 2. Verify

```bash
python -c "import sqlite3;c=sqlite3.connect('/app/data/queue.db');[print(t,c.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]) for t in ('jobs','tracks','track_owners','sessions')]"
```

Expected: `0` for `jobs`, `tracks`, `track_owners`; non-zero for `sessions`.

### 3. Restart the app in Coolify

So `db.init()` reapplies the schema and `startup` re-logs the cookies banner.

## What the cleanup script does

- `DELETE FROM track_owners` — per-user library membership.
- `DELETE FROM tracks` — master registry (one row per `(video_id, codec, bitrate)`).
- `DELETE FROM jobs` — queue/history of every download.
- `VACUUM` — reclaims the file space and discards WAL.
- For each subdir under `/app/data/library/` — `shutil.rmtree` (the physical
  `.mp3` / `.m4a` / `.flac` files).

## Order matters

`track_owners` first because it has `FK ... ON DELETE CASCADE` against
`tracks`. Reverse order would still work due to cascade but explicit is
safer if the connection ever runs with `foreign_keys=OFF`.

## Don't want to nuke files but want a clean DB?

Drop the library cleanup and run only the SQL one-liner above without the
list-comprehension after `c.close();`:

```bash
python -c "import sqlite3;c=sqlite3.connect('/app/data/queue.db');[c.execute(f'DELETE FROM {t}') for t in ('track_owners','tracks','jobs')];c.commit();c.execute('VACUUM');c.close();print('db cleaned')"
```

(The orphaned files under `/app/data/library/` will sit until you delete them
or import the same `(video_id, codec, bitrate)` again, which rewrites them.)

## Nuke everything including sessions

Add `sessions` to the table list — you'll be logged out:

```bash
python -c "import sqlite3,shutil,os;D='/app/data/queue.db';L='/app/data/library';c=sqlite3.connect(D);[c.execute(f'DELETE FROM {t}') for t in ('track_owners','tracks','jobs','sessions')];c.commit();c.execute('VACUUM');c.close();[shutil.rmtree(os.path.join(L,e)) for e in (os.listdir(L) if os.path.isdir(L) else []) if os.path.isdir(os.path.join(L,e))];print('done')"
```

## Running from the Oracle host instead of Coolify Terminal

If the web terminal misbehaves (no heredoc, eats long lines, etc.), SSH in:

```bash
docker exec -it $(docker ps --filter "name=ytdl" --format "{{.ID}}" | head -1) bash
```

Then run the one-liners above from a real bash.
