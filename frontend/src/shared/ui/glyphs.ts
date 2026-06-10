/**
 * Single source of truth for the app's Vaporwave glyph vocabulary. Glyphs were
 * inlined ad hoc across components and a few drifted off-palette (the volume
 * ♪/♪̸ strikethrough, repeat-one's superscript). Importing from here keeps them
 * consistent and renders in VT323. NO emoji — these are typographic glyphs only.
 */
export const G = {
  play: '▶',
  pause: '❚❚',
  prev: '|◀',
  next: '▶|',
  shuffle: '⇄',
  repeat: '↺',
  repeatOne: '↺¹',
  queue: '≣',
  close: '✕',
  expand: '▤',
  owned: '◉',
  add: '⊕',
  warn: '⚠',
  star: '★',
  download: '⬇',
  volume: '♪',
  mute: '♪̸',
  heart: '♥',
  heartEmpty: '♡',
  sleep: '◑',
  autoplay: '∞',
  check: '✓',
  undo: '↺',
} as const

export type Glyph = (typeof G)[keyof typeof G]
