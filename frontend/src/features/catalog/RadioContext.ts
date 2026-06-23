import { createContext, useContext } from 'react'
import type { CatalogItem } from '@/shared/api/types'

/** Lets any catalog row open a "more like this" radio without prop-drilling the
 * setter through every row/section. Provided by CatalogPage. */
export const RadioCtx = createContext<((item: CatalogItem) => void) | null>(null)

/** The radio opener from context, or null when outside a provider. */
export function useRadio(): ((item: CatalogItem) => void) | null {
  return useContext(RadioCtx)
}
