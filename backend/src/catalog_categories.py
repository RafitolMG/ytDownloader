"""
Curated browse categories for the catalog's Spotify-style Browse grid.

Each entry is a fixed seed search run through the same discover pipeline as the
search box: catalog tracks that match show up as playable, YouTube candidates
show up as downloadable. To add/remove/reorder categories, just edit this list —
nothing else needs to change.

Fields:
  slug   stable id used in the URL (/api/catalog/category/<slug>)
  title  display name
  emoji  shown on the card
  query  the YouTube seed search that defines the category
  accent one of the theme accents ('hot' | 'cool' | 'violet') for the card tint
"""

CATEGORIES: list[dict] = [
    {"slug": "lofi",       "title": "Lo-Fi",       "emoji": "🌙", "accent": "cool",   "query": "lofi hip hop beats to relax study"},
    {"slug": "reggaeton",  "title": "Reggaetón",   "emoji": "🔥", "accent": "hot",    "query": "reggaeton 2024 mix"},
    {"slug": "synthwave",  "title": "Synthwave",   "emoji": "🌆", "accent": "violet", "query": "synthwave retrowave 80s mix"},
    {"slug": "pop",        "title": "Pop",         "emoji": "✨", "accent": "hot",    "query": "pop hits 2024"},
    {"slug": "rock",       "title": "Rock",        "emoji": "🎸", "accent": "violet", "query": "classic rock greatest hits"},
    {"slug": "electronic", "title": "Electrónica", "emoji": "🎛️", "accent": "cool",   "query": "electronic dance music mix"},
    {"slug": "hiphop",     "title": "Hip-Hop",     "emoji": "🎤", "accent": "hot",    "query": "hip hop rap hits playlist"},
    {"slug": "jazz",       "title": "Jazz",        "emoji": "🎷", "accent": "cool",   "query": "smooth jazz relaxing mix"},
    {"slug": "indie",      "title": "Indie",       "emoji": "🌿", "accent": "violet", "query": "indie alternative mix"},
    {"slug": "latin",      "title": "Latino",      "emoji": "💃", "accent": "hot",    "query": "latin hits mix 2024"},
    {"slug": "chill",      "title": "Chill",       "emoji": "🧊", "accent": "cool",   "query": "chill relax music"},
    {"slug": "workout",    "title": "Workout",     "emoji": "💪", "accent": "violet", "query": "workout gym motivation music"},
]

CATEGORY_BY_SLUG: dict[str, dict] = {c["slug"]: c for c in CATEGORIES}
