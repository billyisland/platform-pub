// Framer Motion config primitives shared by vessel gestures and (eventually)
// the ∀→H→⊔ ceremonial animations. Slice 5a uses only the drag config; the
// reduced-motion variant disables the post-drag spring while leaving drag
// itself functional.

import type { Transition } from 'framer-motion'

export const VESSEL_DRAG_TRANSITION: Transition = {
  type: 'spring',
  stiffness: 600,
  damping: 40,
  mass: 0.6,
}

export const VESSEL_DRAG_TRANSITION_REDUCED: Transition = {
  duration: 0,
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
