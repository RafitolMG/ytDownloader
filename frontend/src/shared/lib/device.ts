/** True on touch-primary devices (phones/tablets). Used to suppress `autoFocus`
 *  so the on-screen keyboard doesn't pop open the moment a page loads. */
export const isCoarsePointer =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches
