/**
 * Three-bar equalizer marking the track currently loaded in the player. Bars
 * animate while playing and sit static when paused (and under
 * prefers-reduced-motion). Rendered in place of a row's index/number when its
 * (video_id, codec, bitrate) matches the player's current track. Pure CSS — see
 * `.nptick` in index.css.
 */
export function NowPlayingTick({ playing }: { playing: boolean }) {
  return (
    <span
      className="nptick"
      data-playing={playing ? 'true' : 'false'}
      aria-label="now playing"
      title="now playing"
    >
      <span />
      <span />
      <span />
    </span>
  )
}
