# UX/UI audit — pre-production

Scope: the user-facing frontend (`frontend/src/`) on `develop`. Read-only audit; no source
file was modified. `npx tsc -b --force` passes clean.

Every finding is marked **CONFIRMED** (traced in the code) or **SUSPECTED**. Findings already
covered by `docs/improvement-backlog.md` (list virtualization, skeleton loaders, seek-bar
touch target, the glyph map itself) are deliberately **not** repeated here — where a shipped
backlog item is only half-applied, that regression is reported instead and says so.

---

## Executive summary

The app is in much better shape than the seed defect suggested. Loading/error/empty handling
is genuinely thought through on `PlaylistDetailPage`, `StatsPage`, `AdminPage`, `QueueList`,
`SearchResults` and `LoginPage`, and the player's queue/order/shuffle/repeat model and its
consecutive-load-failure backstop are careful work. The problems cluster in four places:

1. **The seed defect class survives in three more views.** A failed fetch renders as an
   *empty* state on the Albums library grid, in the category feed and in radio. The Albums one
   is the worst: a user whose `/api/library` call fails is told "no albums yet — search an
   album above and download it", which reads as *your library is gone*.
2. **Offline is honest per-playlist but dishonest app-wide.** Downloads live on the device and
   `PlaylistDetailPage` falls back to them correctly — but the only route to a downloaded
   playlist is a list that requires the network. After an offline cold start the user has no
   navigable path to music that is physically on their phone.
3. **The Capacitor build has silent dead-ends.** File downloads (video / audio-as-file /
   playlist zip) and playlist JSON export produce no file at all in the APK while the UI reports
   success, and "share" copies a `https://localhost/...` link.
4. **One global keyboard handler breaks every button.** The Space hotkey `preventDefault()`s on
   any focused `<button>`, so while a track is loaded Space toggles playback *instead of*
   activating the control the user is on.

Silent mutation failure is the recurring smaller theme: ~10 mutations across the queue, admin
console, liked songs, album download and save-queue have no `onError`, so a failed action looks
exactly like an action that did nothing.

Counts: 3 Critical, 6 High, 14 Medium, 10 Low — all CONFIRMED unless noted.

---

## Critical

### C1 — A failed library fetch renders the Albums page as "no albums yet"
`frontend/src/pages/AlbumsPage.tsx:209-218`

`libraryQuery.isError` is never handled: the empty branch is gated only on
`!isLoading && libraryAlbums.length === 0`, so an error resolves to the `EmptyState`.

**Symptom:** a user with 200 albums opens Albums on a dropped connection (or during a backend
blip) and sees "◉ no albums yet — search an album above and download it — its tracks group here
automatically." Nothing indicates a failure and there is no retry. This is the exact defect the
audit was commissioned for, one page over from where it was fixed.

**Severity: Critical** (misleads the user about their own data).

### C2 — Downloaded playlists are unreachable after an offline cold start
`frontend/src/pages/PlaylistsPage.tsx:96-130`, `frontend/src/features/offline/OfflineProvider.tsx:224-248`,
`frontend/src/pages/PlaylistDetailPage.tsx:118-130`

`PlaylistDetailPage` correctly falls back to the on-disk manifest when the fetch fails. But
`PlaylistsPage` — the only way to *reach* a playlist — has no offline fallback: it renders
"failed to load playlists: …" and nothing else. `offlineTracksFor()` / `playlistName()` exist
on the offline context and are consulted by exactly one screen. There is no React Query
persister (`gcTime` is 5 min, in-memory only), so after an app restart the cache is empty.

**Symptom:** user downloads three playlists for a flight, kills the app, boots it in airplane
mode. Catalog: "failed to load". Albums: "no albums yet" (C1). Playlists: "failed to load
playlists". Liked: "couldn't load your songs". The music is on the device and the app offers no
way to browse to it — the only surviving entry point is whatever queue the player restored from
`localStorage`. The headline offline feature is inaccessible in exactly the situation it exists
for.

**Severity: Critical** (user is stuck; the feature's promise is inverted).

### C3 — "Download as file" in the Android app produces no file, but reports success
`frontend/src/features/capture/useCapture.ts:39-47` and `:224-251`,
`frontend/src/pages/PlaylistDetailPage.tsx:658-679`,
`frontend/android/app/src/main/java/com/rafitol/ytdownloader/MainActivity.java`

`triggerFileDownload()` creates an `<a download href=…>` and clicks it. In the APK the page
origin is `https://localhost` (`capacitor.config.ts` → `androidScheme: 'https'`) while the file
URL is `https://ytdl.rafitolmg.dev/...` (`.env.capacitor`), so the `download` attribute is
cross-origin and ignored; and `MainActivity` is a bare `BridgeActivity` with no
`setDownloadListener`, so the WebView has nowhere to route the resulting navigation. The same
applies to the blob-based playlist `⬇ export`.

**Symptom:** on the phone the user picks "▼ to device · download as file" (or a playlist zip,
or `⬇ export`), the progress bar runs to 100 %, the panel says "✓ complete" — and no file ever
appears on the device. The server did the work and charged the wait; the user is told it
succeeded.

**Severity: Critical** (misleads about the outcome of the app's core non-streaming action on
its primary platform).

---

## High

### H1 — The global Space hotkey swallows activation on every button
`frontend/src/features/player/useGlobalPlayerHotkeys.ts:24-38`

The handler is bound on `window` and only excludes `INPUT / TEXTAREA / SELECT /
contenteditable`. `BUTTON` is not excluded, and the Space branch calls `e.preventDefault()` —
which cancels the browser's synthesized click on the focused button. React's own row handlers
run first (root container) but don't `stopPropagation()`, so the window handler always fires
too.

**Symptom:** with any track loaded, a keyboard user tabs to `♥ save to library`, `⬇ download`, a
sort filter, or `⚠ confirm delete` and presses Space: the button does nothing and the music
pauses instead. On `role="button"` rows the row *does* play (it handles the key itself) and the
player *also* toggles, so one keypress fires two conflicting actions.

**Severity: High** (keyboard operation of the whole app degrades the moment music is loaded).

### H2 — Category and radio feeds present a failed fetch as "nothing found"
`frontend/src/features/catalog/views.tsx:90-94` and `:290-294`;
`frontend/src/pages/CatalogPage.tsx:236-251`

`CategoryView` and `RadioView` accept `feed` + `isLoading` but no error signal, and `CatalogPage`
never passes one. On error, `feed` is `undefined`, `isLoading` is false, so the fall-through
renders "nothing found for this category right now." / "couldn't tune a radio for this track
right now."

**Symptom:** a user taps a browse category on a flaky connection and is told the category is
empty. There is no retry control and no way to distinguish it from a genuinely empty category —
the same failure the Albums fix addressed.

**Severity: High.**

### H3 — A dropped WebSocket freezes the bulk import forever
`frontend/src/pages/ImportPage.tsx:46-98`

`subscribe()` registers only `ws.onmessage`. There is no `onclose`, no `onerror`, no unmount
cleanup and no cancel affordance. `useCapture.ts:269-280` handles exactly this case (a
`terminated` flag distinguishing a normal close from a mid-job drop) — `ImportPage` is a
drifted copy that lost it.

**Symptom:** user pastes a 90-track Spotify playlist, the phone switches WiFi→LTE (or the screen
sleeps and the socket is reaped). The progress bar stops where it was, the button stays disabled
on "··· importing", and nothing ever changes. The import is still running server-side, but the
page can neither tell them that nor be reset without a reload.

**Severity: High** (user stuck with no information and no exit).

### H4 — An offline download that fails before the loop leaves the button completely inert
`frontend/src/features/offline/OfflineProvider.tsx:126-137`, `frontend/src/features/offline/OfflineDownloadButton.tsx:79-88`

`downloadPlaylist` does `await ensureMediaToken()` **before** the first `setActive(...)`. If that
throws (no connection, expired session), the promise rejects into the caller's `void
off.downloadPlaylist(...)` — an unhandled rejection with no toast, no state change, no progress
entry.

**Symptom:** user taps `⬇ download` to save a playlist for offline, on a connection that has just
gone bad. The button does not flinch — no spinner, no error, no count. Tapping again does the
same nothing. It is indistinguishable from a dead button.

**Severity: High.**

### H5 — "Share" copies a localhost URL in the Android app
`frontend/src/pages/PlaylistDetailPage.tsx:626-645` (`window.location.origin` at `:632`)

In the APK `window.location.origin` is `https://localhost`.

**Symptom:** the user opens a public playlist on their phone, taps `◈ share`, gets "share link
copied", pastes it into WhatsApp — and the recipient gets `https://localhost/playlists/<uuid>`,
which resolves to nothing. The toast said it worked.

**Severity: High** (silent wrong result on the primary platform).

### H6 — Sort buttons vanish under the user's finger on the catalog
`frontend/src/pages/CatalogPage.tsx:326-392`

The whole "full catalog" section — collapse toggle, `▶ play all` and the four sort buttons — is
gated on `dbItems.length > 0`. Changing the sort creates a new query key (`['catalog', {sort}]`)
with no `placeholderData`, so `data` is `undefined` during the fetch and the entire section
unmounts.

**Symptom:** user expands the catalog, taps "title a→z"; the sort row, the play-all button and
300 rows all disappear, replaced by a one-line "··· loading catalog ···", then reappear. On a
slow connection this reads as the tap having broken the page, and the control they wanted to
tap again is gone.

**Severity: High** (interaction-destroying layout collapse on a primary control).

---

## Medium

### M1 — The player bar re-renders its whole queue list ~4×/second
`frontend/src/features/player/PlayerBar.tsx:19`, `:41-42`, `:284-359`

`PlayerBar` subscribes to `usePlaybackTime()` for the scrubber, so the component function re-runs
on every `timeupdate` (≥4 Hz, up to 60 Hz). `PlayQueuePanel` and `NowPlayingView` are rendered
as children of that same component and are not memoized, so their full list subtrees reconcile
on every tick.

**Symptom:** user hits `▶ play all` on the 300-track catalog, then opens the queue panel to
reorder: 300 rows (each with an `<img>`) reconcile several times a second while the panel is
open. On a mid-range phone this shows up as sluggish scrolling in the panel and battery drain.
`playbackStore.ts` was built precisely to stop ticks reaching list rows; this is the one place
the escape hatch is bypassed.

**Severity: Medium.**

### M2 — Repeat uses a different glyph in the two player surfaces
`frontend/src/features/player/PlayerBar.tsx:149` (`↻` / `↻¹`) vs
`frontend/src/features/player/NowPlayingView.tsx:172` (`G.repeat` = `↺` / `↺¹`)

`shared/ui/glyphs.ts` exists as the single source of truth and `NowPlayingView` uses it;
`PlayerBar` still hardcodes every transport glyph and picked the *other* arrow. `↻` is also the
`RefreshButton` glyph (`shared/ui/RefreshButton.tsx:26`), so in the mini player "repeat" and
"refresh" render identically.

**Symptom:** the same control shows `↻` in the mini player and `↺` in the expanded view; the
mini-player repeat button looks like the catalog's re-roll button.

**Severity: Medium** (consistency; the shared map already shipped — this is incomplete adoption).

### M3 — Toasts cover the mini player on phones
`frontend/src/shared/ui/ToastProvider.tsx:58` (`bottom-24` = 96 px)

On phones the player bar occupies roughly 56 px → 118 px from the bottom (`bottom-[calc(3.5rem
+ safe-area)]` plus ~62 px of height), and toasts are `z-[70]` against the player's `z-40`.

**Symptom:** the user removes a track, and the "removed — ↺ undo" toast sits on top of the
transport controls for six seconds. Reaching for play/pause during that window hits the toast.

**Severity: Medium.**

### M4 — Play badges on album and mix cards are invisible on touch *and* steal the tap
`frontend/src/pages/AlbumsPage.tsx:301-314`, `frontend/src/features/catalog/cards.tsx:213-226`,
`frontend/src/features/catalog/cards.tsx:44-59`

`opacity-0 group-hover:opacity-100` hides these buttons on touch, but opacity-0 elements still
receive pointer events, and the album/mix handlers call `e.stopPropagation()`.

**Symptom:** on a phone, tapping the bottom-right ~36 px of an album cover starts playing the
album instead of opening it, with nothing on screen explaining why. Tapping a suggestion card's
artwork starts a stream preview from an affordance the user never saw. The codebase already has
the right pattern — `opacity-100 lg:opacity-0 lg:group-hover:opacity-100`
(`PlaylistDetailPage.tsx:464`, `PlayerBar.tsx:349`) — it just wasn't applied to the cards.

**Severity: Medium.**

### M5 — Both slide-over drawers stay in the tab order while closed
`frontend/src/shared/ui/SideMenu.tsx:38-45`, `frontend/src/features/queue/QueueDrawer.tsx:38-45`

Closed state is `-translate-x-full` / `translate-x-full` only — no `inert`, no
`visibility:hidden`, no `pointer-events-none` on the panel itself. Their links and close buttons
remain focusable. (`QueueDrawer` guards its *contents* with `{open && …}`, but not its header
button.)

**Symptom:** a keyboard user tabbing through the header suddenly loses the focus ring off-screen,
and Enter navigates to `/import` or `/stats` from a menu that isn't visible. Screen readers
announce two `aria-modal` dialogs that aren't open.

**Severity: Medium.**

### M6 — The track-actions menu fails silently and is unreachable by keyboard
`frontend/src/features/playlists/AddToPlaylistMenu.tsx:194-225` and `:136-148`

`playlistsQuery.isError` is not handled — only `isLoading` and `data` branches exist. The menu is
`createPortal`'d to `document.body` with no focus move, no `role="menu"`, and no focus trap.

**Symptom (error):** the menu opens showing "░ add to playlist ░", a blank gap where the list
should be, and the "new playlist name" form — implying the user has no playlists rather than
that the request failed. **Symptom (keyboard):** the menu renders at the end of `<body>`, so
tabbing from the trigger walks into the next row's buttons; the menu's contents are only
reachable after tabbing through the entire remaining page.

**Severity: Medium.**

### M7 — Silent mutation failures across the app
No `onError` on any of:

| What | Where |
| --- | --- |
| queue job retry / cancel / delete | `frontend/src/features/queue/JobRow.tsx:41-43` |
| admin job cancel / retry / delete | `frontend/src/pages/AdminPage.tsx:303-314` |
| admin track force-delete | `frontend/src/pages/AdminPage.tsx:456-467` |
| admin backfill / tidy / refetch artists | `frontend/src/pages/AdminPage.tsx:611-696` |
| save queue as playlist | `frontend/src/features/player/PlayerBar.tsx:373-398` |
| download whole album | `frontend/src/pages/AlbumsPage.tsx:745-753` |
| remove from liked songs | `frontend/src/pages/LikedSongsPage.tsx:240-262` |

A shared `useToast()` with an error variant already exists and is used correctly in
`rows.tsx:45-49` and `PlaylistDetailPage.tsx:64-105`, so this is drift, not a missing capability.

**Symptom:** user taps `↻ retry` on a failed job; the button greys for a moment and returns to
`↻ retry` with the job still in `error`. Nothing says whether the retry was rejected or the tap
missed. Same for `⬇ download album` — the label goes back to its idle text.

**Severity: Medium.**

### M8 — Removing a liked song stops playback before knowing whether it worked
`frontend/src/pages/LikedSongsPage.tsx:333-341`

`if (isCurrent) player.stop()` runs synchronously before `remove.mutate()`, and the mutation has
no `onError`.

**Symptom:** on a flaky connection the user taps ♥ on the track that is playing: the music stops,
the queue is cleared, the track stays in the list, and no message appears. They have lost their
listening session for an action that didn't happen.

**Severity: Medium.**

### M9 — Searching Liked Songs to zero matches renders nothing at all
`frontend/src/pages/LikedSongsPage.tsx:180-220`

The empty state is gated on `items.length === 0`; the list on `filtered.length > 0`. A search
that matches nothing falls between them.

**Symptom:** user types a typo in "search your liked songs…" and the page below the search box
goes completely blank — no "no matches", no count, no hint that the filter is responsible.

**Severity: Medium.**

### M10 — Offline download failures are invisible and the progress counter lies
`frontend/src/features/offline/OfflineProvider.tsx:139-190` (the empty `catch` at `:183`),
`frontend/src/features/offline/OfflineDownloadButton.tsx:37-39`, `:86`

Per-track failures are swallowed, and `setActive` increments on the loop index — including for
tracks that failed — so progress always reaches `total/total`.

**Symptom:** the user downloads a 20-track playlist on weak signal, watches "··· 20/20", and then
the button settles on "⬇ 12/20". Eight tracks failed, nothing said so, and there is no
retry-failed action (tapping again re-runs the whole playlist, which does at least recover).

**Severity: Medium.**

### M11 — No buffering state anywhere in the player
`frontend/src/features/player/AudioPlayerProvider.tsx:210-216`, `:719-791`

The `<audio>` element wires `play/pause/timeupdate/loadedmetadata/ended/error` but not
`waiting` / `stalled` / `canplay`. `isPlaying` flips on the `play` event, which fires while the
media is still buffering.

**Symptom:** on a slow mobile connection the user taps ▶; the button immediately becomes ❚❚, the
scrubber sits at 0:00, and no sound comes out for several seconds. There is no spinner and no
"buffering" text, so the only reading available is "it's broken" — and tapping again pauses the
load that was in flight.

**Severity: Medium.**

### M12 — The end of the queue is silent while auto-radio fetches, and stays silent if it finds nothing
`frontend/src/features/player/AudioPlayerProvider.tsx:742-757`, `:553-581`

`onEnded` calls `triggerAutoRadio()` and returns. That is a network round-trip
(`api.radio(...)`) with no UI signal, and if `fresh.length === 0` (or the call throws — the
`catch` is empty) nothing at all happens.

**Symptom:** the last track ends. Silence. The user doesn't know whether the app is fetching more
music, has finished, or has failed. Settings promises "Infinite radio (∞) is always on"
(`SettingsPage.tsx:40-43`), which makes an unexplained stop read as a bug.

**Severity: Medium.**

### M13 — Body text on cards is below WCAG AA in the vaporwave palette
`frontend/src/index.css:18` (`--color-ink-lo: #9a7fc0`), `:21` (`--color-hot`), `:25`
(`--color-crit`), against `.card-vapor` (`:223-231`)

The token comment documents 5.85:1 — that is against `--color-page` (`#0d0420`). Nearly all
`text-ink-lo` sits on `card-vapor` (`rgba(45,27,78,0.55)`), which composites over the page
gradient's lighter lower half (`#4a1854`) to roughly `#3a1951`. Measured against that:

| token | on `card-vapor` (lower page) | typical size |
| --- | --- | --- |
| `text-ink-lo` `#9a7fc0` | **≈ 4.26:1** | 10–14 px |
| `text-hot` `#ff2975` | **≈ 4.04:1** | 10–12 px |
| `text-crit` `#ff4d5e` | **≈ 4.47:1** | 12 px |

All three miss AA (4.5:1) for normal-size text, and the fixed scanline overlay
(`index.css:174-195`) subtracts a little more. This is *within* the existing palette — the cyan
and `ink-hi`/`ink-mid` tokens are fine — so it is a placement problem (small `ink-lo`/`hot`
labels on translucent cards), not an argument against the design language.

**Symptom:** secondary metadata (artist lines, "N tracks", timestamps, `⚠` error text in
`ExternalRow`) is hard to read on the lower half of a long page, worst on a phone in daylight.

**Severity: Medium.** SUSPECTED for the exact ratios (they depend on where on the gradient the
card falls); CONFIRMED that the documented 5.85:1 does not hold on `card-vapor`.

### M14 — The pixel typeface is a network dependency
`frontend/index.html:11-16`

Monoton, VT323 and Inter are loaded from `fonts.googleapis.com`. The Capacitor build bundles the
SPA locally but not the fonts.

**Symptom:** first launch of the APK with no connection (or any offline session after a cold
start) renders the entire "1989" identity in `JetBrains Mono` / `system-ui` fallbacks — the
`font-display` Monoton title, all `font-pixel` labels, everything. `display=swap` also means a
visible reflow on every cold web load.

**Severity: Medium** (the validated visual language is the first thing lost offline).

### M15 — The suggestions carousel disappears — with its retry — on error
`frontend/src/pages/CatalogPage.tsx:277-300`

Gated on `suggestionsQuery.isLoading || suggestions.length > 0`. An error satisfies neither, so
the section header, the skeletons and the `↻` refresh button all unmount.

**Symptom:** "✦ suggestions for you" silently vanishes from browse home. The user can't tell it
failed and has no control left to retry it. (`statsQuery` and `activityQuery` errors are equally
unreported; the banner at `:204-209` only covers mixes, recents and categories.)

**Severity: Medium.**

### M16 — Users are shown raw transport errors while the app already knows it's offline
`frontend/src/shared/api/client.ts:142-151`; consumers e.g. `CatalogPage.tsx:305-310`,
`PlaylistsPage.tsx:99-104`, `LikedSongsPage.tsx:173-178`

Error text is `${status}: ${detail}` or, for a network failure, the browser's own
`TypeError: Failed to fetch`. `useOnlineStatus()` exists and the header already renders a
"◌ offline" chip (`AppHeader.tsx:31-37`), but no page consults it when composing an error.

**Symptom:** an offline user reads "failed to load: Failed to fetch" and "could not load
playlist — Load failed" on four different screens, in the app's own voice, with no mention of
the connection the header is simultaneously flagging.

**Severity: Medium.**

### M17 — Playlist reorder has no touch path
`frontend/src/pages/PlaylistDetailPage.tsx:380-399` (HTML5 `draggable` + `dragstart/over/drop`),
`:404-411` (the `⋮⋮` handle is `hidden sm:inline`)

HTML5 drag-and-drop does not fire from touch input, and the affordance is hidden below `sm`
anyway.

**Symptom:** on the phone — the primary target — a playlist's order simply cannot be changed;
nothing on screen suggests the capability exists, and there is no long-press or move-up/down
alternative.

**Severity: Medium.**

### M18 — The mini player's ✕ destroys the queue with no confirmation, 8 px from the queue button
`frontend/src/features/player/PlayerBar.tsx:191-212`

`p.stop()` clears `queue`, `order`, `pos` and removes the `localStorage` snapshot
(`AudioPlayerProvider.tsx:381-393`, `:503-521`). On phones `≣` (32 px) and `✕` (~30 px) sit
adjacent in the right cluster with a `gap-2`; the time and volume controls that separate them on
desktop are hidden.

**Symptom:** a mis-tap on a phone discards a hand-built 40-track queue permanently — no confirm,
no undo, and the persisted copy is deleted too. `ConfirmButton` and the undo-toast pattern both
already exist in the codebase.

**Severity: Medium** (data loss, mitigated only by it being a queue rather than a playlist).

### M19 — Sub-40 px touch targets in the mini player
`frontend/src/features/player/PlayerBar.tsx:236` (prev/next/shuffle/repeat: `w-8 h-8` = 32 px on
phones), `:349` (queue-row remove: `w-6 h-6` = 24 px), `:196` (queue toggle: 32 px)

The primary play button is correctly 40 px and `NowPlayingView` uses 44 px throughout, so the
target size is understood — the mini bar is the outlier.

**Symptom:** skipping tracks one-handed on a phone frequently misses, and the miss lands on
either the neighbouring transport button or the queue-destroying ✕ (M18).

**Severity: Medium.**

### M20 — Rows are `role="button"` containing buttons
`frontend/src/features/catalog/rows.tsx:71-166`, `frontend/src/pages/LikedSongsPage.tsx:269-349`,
`frontend/src/pages/PlaylistDetailPage.tsx:369-469`, `frontend/src/pages/AlbumsPage.tsx:538-576`,
`frontend/src/pages/StatsPage.tsx:135-161`, `frontend/src/features/catalog/cards.tsx:298-333`

Each list row is a `<li role="button" tabIndex=0>` whose children include real `<button>`s
(♥ save, ≣+ actions, ✕ remove). Interactive content inside a `button` role is invalid ARIA;
assistive tech flattens the row to its accessible name and the nested controls become
unreachable or double-announced.

**Symptom:** a screen-reader user hears "play <title>, button" and cannot get to the save or
add-to-playlist actions inside that row.

**Severity: Medium.**

---

## Low

- **L1 — Dead duplicate component.** `frontend/src/features/capture/UrlInput.tsx` (whole file) is
  imported by nothing; `CapturePage` uses `SearchBar`. It carries a drifted copy of the "░▒▓
  stream capture ▓▒░" header and will rot.
- **L2 — Two debounce hooks.** `frontend/src/features/search/useSearch.ts:17-24` (`useDebounced`)
  duplicates `frontend/src/shared/lib/useDebouncedValue.ts:5-12`.
- **L3 — "✓ queued 0 (some failed)".** `frontend/src/features/catalog/rows.tsx:206-232` — because
  `Promise.allSettled` always resolves, a batch where *every* download failed still renders with a
  ✓ and the word "queued".
- **L4 — Now-playing cover gated on the wrong field.**
  `frontend/src/features/player/NowPlayingView.tsx:85-96` tests `t.thumbnail_url` but renders
  `p.coverUrl`; a track with a YT-Music/offline cover but no stored thumbnail shows the gradient
  placeholder instead of its art.
- **L5 — Downloaded storage is invisible.** `OfflineProvider` computes `totalBytes`
  (`:62-66`, `:254`) and nothing renders it; `SettingsPage.tsx:36-51` has a "// app" section that
  never mentions offline downloads. Users cannot see or reclaim the space their downloads use
  except playlist by playlist.
- **L6 — "Liked Songs · 0 tracks" on a failed fetch.** `frontend/src/pages/PlaylistsPage.tsx:60`
  and `:119` — `likedCount` falls back to 0 with no error branch, so a failed library call is
  rendered as a fact on the card.
- **L7 — Dead `isMine` branch.** `frontend/src/pages/CatalogPage.tsx:44` hardcodes `false`,
  leaving unreachable copy at `:319-321` ("your library is empty — tap ♡ …") and dead conditions
  at `:78`, `:183-184`.
- **L8 — Icon-only buttons whose accessible name is the glyph.**
  `frontend/src/features/catalog/rows.tsx:123-166` (♥/♡ + count, `≣+`) and
  `frontend/src/pages/LikedSongsPage.tsx:320-331` rely on `title`, which does not override text
  content — screen readers announce "♥ 3" and "≣+". Sibling controls (`ExternalRow`'s preview and
  download, `PlayerButton`, `QueueIndicator`) do carry `aria-label`.
- **L9 — Search dropdown has no combobox semantics.**
  `frontend/src/features/search/SearchBar.tsx:100-122`, `:163-195` — arrow-key navigation and an
  `activeIdx` highlight exist, but there is no `role="combobox"/"listbox"/"option"`,
  `aria-expanded` or `aria-activedescendant`, so none of it is announced.
- **L10 — Space scrolls the page on card-style `role="button"`s.**
  `frontend/src/pages/AlbumsPage.tsx:280-282` and
  `frontend/src/features/catalog/cards.tsx:178-180` handle Space without `preventDefault()` (the
  list rows elsewhere do). Interacts with H1.

---

## No issues found

Stated explicitly, because these were checked and came back clean:

- **`StatsPage`** — loading / error / empty / success all present and distinct, including a
  `hasData` check that doesn't confuse "zero plays" with "failed".
- **`AdminPage` view states** — every tab (`overview`, `users`, `jobs`, `storage`, `system`) has a
  `Loading` / `ErrorLine` / empty-card / data path. Only its *mutations* are silent (M7).
- **`PlaylistDetailPage` state handling** — the best on the app: loading, error-with-offline-
  fallback, error-with-link-out, empty (owner-aware copy), success, plus optimistic reorder with
  rollback and an undo toast on removal.
- **`QueueList` / `JobRow`** — loading, error-only-when-empty, filter-aware empty state, live WS
  overlay that resets on terminal states.
- **`SearchResults`** — all four states, with distinct copy.
- **Auth** — `AuthProvider` / `RequireAuth` / `RequireAdmin` / `LoginPage`: cached-user seeding for
  offline cold starts, 401-vs-network distinction, query-cache clearing between accounts, a
  session-loading state, and typed error copy on the login form.
- **App shell** — `ErrorBoundary`, themed 404, themed route-chunk `Suspense` fallback,
  `ScrollToTop`, per-route code splitting.
- **Back-gesture handling** — `backStack.ts` + `BackButtonHandler`: `NowPlayingView`, `SideMenu`,
  `QueueDrawer`, both playlist dialogs, the Albums detail view and the Catalog drill-downs all
  register. The only overlay that doesn't is `PlayQueuePanel` (`PlayerBar.tsx:284`) — minor, since
  it is a small anchored panel, not a full-screen surface.
- **Player queue model** — `canGoNext` / `canGoPrev` / shuffle rebuild / reshuffle-on-wrap /
  repeat-one / `prev` 3-second rewind / consecutive-failure cap with a toast / persistence and
  paused resume: all internally consistent, and row highlighting keys on
  `(video_id, codec, bitrate)` identically in all six list components.
- **MediaSession** — the artwork-crash guard (`nativeSafeArtwork`) and the non-zero
  `playbackRate` guard are both in place, with the reasoning documented at the call site.
- **Lazy images** — every list/card `<img>` carries `loading="lazy"` and `referrerPolicy`, and
  every one sits in an explicit `aspect-video`/`aspect-square` box, so there is no layout shift
  from unsized images.
- **Reduced motion** — scanlines, caret blink, VHS jitter, spin/pulse and the now-playing tick all
  respect `prefers-reduced-motion` (`index.css:252-258`, `:360-362`).

---

## Coverage

**Read in full:** `app/router.tsx`, `app/providers.tsx`, `app/ErrorBoundary.tsx`,
`app/BackButtonHandler.tsx`, `main.tsx`, `index.css`, `index.html`, `capacitor.config.ts`,
`vite.config.ts`, `.env.capacitor`, `android/.../MainActivity.java`; pages `AlbumsPage`,
`CatalogPage`, `LikedSongsPage`, `PlaylistsPage`, `PlaylistDetailPage`, `CapturePage`,
`QueuePage`, `ImportPage`, `SettingsPage`, `StatsPage`, `LoginPage`, `AdminPage`; features
`player/*` (all 7 files), `catalog/*` (all 7), `offline/*` (all 4), `queue/*` (all 4),
`search/*` (all 4), `capture/*` (all 5), `playlists/AddToPlaylistMenu`, `auth/*` (all 3);
shared `ui/*` (all 14), `lib/*` (all 7), `api/useJobs`.

**Partially read:** `shared/api/client.ts` (lines 1-190 — error shaping, media-token and URL
construction; the remaining endpoint definitions are backend-contract surface and belong to the
sibling audits). `shared/api/types.ts` and `schemas.ts` were consulted for field shapes only.

**Not examined:** everything under `backend/` (out of lane), the Android Gradle/manifest config
beyond `MainActivity`, `frontend/dist/`, and the app icon/splash assets.

**Verification method:** every finding above was traced in the source. The two claims resting on
platform behaviour rather than only on this repo's code are C3 (Capacitor WebView ignores a
cross-origin `a[download]` with no `DownloadListener` registered) and H5 (`window.location.origin`
under `androidScheme: 'https'`); the repo-side facts each depends on — the bare `BridgeActivity`,
the `VITE_API_BASE` cross-origin split, the `androidScheme` setting — are confirmed. M13's exact
contrast ratios are computed against a sampled point on the page gradient and are marked
SUSPECTED for that reason.
