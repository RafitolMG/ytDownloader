"""
Curated browse categories for the catalog's Browse grid.

Each entry is a fixed seed search run through the discover pipeline with the
music filter on, so the feed surfaces individual songs (not hour-long mixes or
non-music videos). To add/remove/reorder categories, just edit this list.

Queries are deliberately song-oriented (avoid "mix"/"playlist"/"full album"
terms, which YouTube answers with compilation streams that the song-length
filter then discards).

Fields:
  slug   stable id used in the URL (/api/catalog/category/<slug>)
  title  display name
  query  the YouTube seed search that defines the category
  accent one of the theme accents ('hot' | 'cool' | 'violet') for the card tint
"""

CATEGORIES: list[dict] = [
    {"slug": "lofi",       "title": "Lo-Fi",       "accent": "cool",   "query": "lofi type beat"},
    {"slug": "reggaeton",  "title": "Reggaetón",   "accent": "hot",    "query": "reggaeton"},
    {"slug": "synthwave",  "title": "Synthwave",   "accent": "violet", "query": "best synthwave songs"},
    {"slug": "pop",        "title": "Pop",         "accent": "hot",    "query": "pop songs 2024"},
    {"slug": "rock",       "title": "Rock",        "accent": "violet", "query": "rock songs"},
    {"slug": "electronic", "title": "Electrónica", "accent": "cool",   "query": "edm songs"},
    {"slug": "hiphop",     "title": "Hip-Hop",     "accent": "hot",    "query": "hip hop songs"},
    {"slug": "jazz",       "title": "Jazz",        "accent": "cool",   "query": "jazz songs"},
    {"slug": "indie",      "title": "Indie",       "accent": "violet", "query": "indie songs"},
    {"slug": "latin",      "title": "Latino",      "accent": "hot",    "query": "latin songs 2024"},
    {"slug": "chill",      "title": "Chill",       "accent": "cool",   "query": "chill songs"},
    {"slug": "workout",    "title": "Workout",     "accent": "violet", "query": "workout songs"},
]

CATEGORY_BY_SLUG: dict[str, dict] = {c["slug"]: c for c in CATEGORIES}
