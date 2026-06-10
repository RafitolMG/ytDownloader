/**
 * Thumbnail with a built-in vaporwave gradient placeholder for the no-image
 * case. Centralizes the `img || gradient` pattern that was copy-pasted across
 * every list/card. Lazy-loads and strips the referrer (YouTube thumbs 403 with
 * one). `ratio` picks the aspect box; `className` sizes the wrapper.
 */
export function Thumb({
  src,
  alt = '',
  className = '',
  ratio = 'video',
  rounded = 'rounded-xs',
}: {
  src: string | null | undefined
  alt?: string
  className?: string
  ratio?: 'video' | 'square'
  rounded?: string
}) {
  const aspect = ratio === 'square' ? 'aspect-square' : 'aspect-video'
  return (
    <div
      className={`relative ${aspect} overflow-hidden border border-border bg-page-mid ${rounded} ${className}`}
    >
      {src ? (
        <img
          src={src}
          alt={alt}
          className="w-full h-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-violet/40 via-hot/20 to-cool/30" />
      )}
    </div>
  )
}
