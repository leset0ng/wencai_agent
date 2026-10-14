import { useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { applyThemeMode, getThemeMode, subscribeTheme } from '#/lib/theme'

export function useThemeMode() { return useSyncExternalStore(subscribeTheme, getThemeMode, () => 'auto' as const) }
export function ThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => { applyThemeMode(); return subscribeTheme(() => {}) }, [])
  return children
}
