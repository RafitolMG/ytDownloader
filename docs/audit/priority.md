# Audit backlog, re-ranked across the three lanes

The three agents ranked findings *within* their own lane, blind to each other.
Merging them changes the picture. This is the consolidated view after the first
two rounds of fixes (commits `99b9fdc`, `bf47d82`).

## What the merge revealed

**`retry_job` was found broken by all three lanes independently.** Security: it
bypassed the extraction rate limiter (High). API: same bypass plus a silent
`own=False` → `True` flip (M5). API again: retrying a track-list import always
400s, because the handler dispatches on `is_playlist` and sends it through
`_validate_youtube_url('tracklist-import')` (M2). Three agents converging on one
25-line function says the function is the problem, not the three symptoms.

**The worst bug in the app was ranked "High", not Critical** — only because the
API lane had no Critical band in play. Every ⬇ button in the catalog,
suggestions, radio and album views sat disabled forever on every platform
(`useLiveJobProgress` never set `status` on the terminal event). Cross-lane it
outranks two of the three UX "Criticals", which were APK-only.

**One systemic defect class accounts for most of the backlog:** *the operation
failed or did nothing, and the UI says otherwise.* The album seed bug, the four
mute states, ~10 mutations with no `onError`, M6 (`PATCH` returns ok while
discarding the patch) and M3 (upstream failure returned as 200-empty) are all the
same shape. Attack it as a class, not as twelve tickets.

**One priority went up because of our own fix.** M7 (the progress-WS sends its
snapshot before subscribing, and the success paths never pop `_jobs`) used to be
theoretical — nothing depended on the terminal event. Now the ⬇ buttons do.

## Re-ranked remaining work

| # | Finding | Lane rank | Now | Why it moved |
|---|---|---|---|---|
| 1 | `PATCH /api/playlists` answers 200 while discarding the whole patch (M6) | Medium | **High** | Silent wrong result on a normal action — renaming a playlist can do nothing and report success |
| 2 | Upstream failures returned as 200-empty / 404 instead of 502 (M3) | Medium | **High** | Server-side root of the "nothing found" family we just patched client-side; fixing it here removes the class |
| 3 | `list_catalog` leaves `%`/`_` live in `LIKE`, and folds no accents (M4) | Medium | **High** | Spanish-language catalog: `q=cancion` misses `Canción` every day, and `q=%` dumps everything |
| 4 | Retrying a track-list import always 400s (M2) | Medium | Medium | Third defect in `retry_job` — fix the dispatch, not the symptom |
| 5 | Retry silently flips `own=False` → `True` (M5 remainder) | Medium | Medium | A daily-mix track that is retried gets favourited without asking |
| 6 | Progress-WS snapshot/subscribe race + `_jobs` never popped on success (M7) | Medium (SUSPECTED) | Medium ↑ | Now load-bearing: the ⬇ buttons depend on the terminal event |
| 7 | No request-body size or string-length limit anywhere (Sec #3) | Medium | Medium | Needs middleware + Pydantic bounds; disk/memory on a small ARM box |
| 8 | No React Query persister — Catalog/Albums/Liked still fail on an offline cold start | (part of C2) | Medium | C2's navigable path is fixed; the stale-data half is not |
| 9 | ~10 mutations with no `onError` (UX M7) | Medium | Medium | Same class as #1 — worth one sweep, not ten tickets |
| 10 | Body text below WCAG AA on cards: `text-ink-lo` ≈4.26:1, `text-hot` ≈4.04:1 (UX M13) | Medium | Medium | Measured against `card-vapor`, not the page — the token's documented 5.85:1 doesn't apply there |
| 11 | Touch cluster: hover-only play badges, sub-40 px targets, closed drawers in the tab order, reorder has no touch path | Medium ×4 | Medium | One pass over the primary platform |
| 12 | Player polish: no buffering state, queue panel re-renders ~4×/s, silent end-of-queue, `↻` vs `↺` | Medium ×4 | Medium-Low | Real but not misleading |
| 13 | Fonts loaded from the Google CDN (UX M14) | Medium | Low-Medium | The 1989 identity disappears offline; self-hosting also drops a third-party dependency |
| 14 | Media tokens: session-wide, 1 h, in the query string (Sec #7) | Low | Low | Small private instance behind HomeAuth |
| 15 | Playlist `cover_url` unvalidated, rendered to other users (Sec #8) | Low | Low | Cross-user IP/UA beacon, not XSS |
| 16 | Raw yt-dlp error text reflected into responses and job rows (Sec #9) | Low | Low | Leaks the cookie path and signed URLs |

## Severities I would not raise

The security lane's negative result stands: no IDOR, no cross-user leakage, no
SQL injection, no path traversal, no SSRF, no command injection. Everything it
found sits in the abuse/availability column. For a small private instance behind
HomeAuth, items 14-16 are correctly Low and should not jump the queue ahead of
the correctness work above.
