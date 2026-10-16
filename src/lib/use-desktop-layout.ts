import { useSyncExternalStore } from 'react'

export const DESKTOP_QUERY = '(min-width: 1024px)'
const subscribe = (listener: () => void) => {
  const media = window.matchMedia(DESKTOP_QUERY)
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}
const snapshot = () => window.matchMedia(DESKTOP_QUERY).matches
export function useDesktopLayout() { return useSyncExternalStore(subscribe, snapshot, () => false) }
