import type { ReactNode } from 'react'

export function ChromaticTitle({
  children,
  as: Tag = 'h1',
  className = '',
}: {
  children: ReactNode
  as?: 'h1' | 'h2' | 'h3'
  className?: string
}) {
  return (
    <Tag
      className={`font-display tracking-[0.15em] text-chromatic uppercase ${className}`}
    >
      {children}
    </Tag>
  )
}
