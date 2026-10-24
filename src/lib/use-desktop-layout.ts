import { useSyncExternalStore } from 'react'

// Narrow laptop/browser windows still use the desktop surface; touch phones retain the mobile layout.
export const DESKTOP_QUERY = '(min-width: 1024px), (min-width: 768px) and (hover: hover) and (pointer: fine)'
const subscribe = (listener: () => void) => {
  const media = window.matchMedia(DESKTOP_QUERY)
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}
const snapshot = () => window.matchMedia(DESKTOP_QUERY).matches
export function useDesktopLayout() { return useSyncExternalStore(subscribe, snapshot, () => false) }
