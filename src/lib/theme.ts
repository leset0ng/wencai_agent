export type ThemeMode = 'light' | 'dark' | 'auto'
export const THEME_STORAGE_KEY = 'theme'
export const THEME_EVENT = 'wencai-theme-change'
let memoryMode: ThemeMode = 'auto'
let sessionOverride: ThemeMode | undefined
export function validThemeMode(value: unknown): value is ThemeMode { return value === 'light' || value === 'dark' || value === 'auto' }
export function resolveTheme(mode: ThemeMode, systemDark: boolean): 'light' | 'dark' { return mode === 'auto' ? systemDark ? 'dark' : 'light' : mode }
export function getThemeMode(): ThemeMode {
  if (typeof window === 'undefined') return 'auto'
  if (sessionOverride) return sessionOverride
  try { const stored = window.localStorage.getItem(THEME_STORAGE_KEY); return validThemeMode(stored) ? stored : 'auto' } catch { return memoryMode }
}
export function applyThemeMode(mode = getThemeMode()) {
  const resolved = resolveTheme(mode, window.matchMedia('(prefers-color-scheme: dark)').matches)
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark'); root.classList.toggle('light', resolved === 'light')
  root.setAttribute('data-theme', resolved)
  root.style.colorScheme = resolved
  if (root.dataset.secureDocument === 'true') root.style.backgroundColor = resolved === 'dark' ? '#202225' : '#fff'
}
export function setThemeMode(mode: ThemeMode) {
  memoryMode = mode
  try { window.localStorage.setItem(THEME_STORAGE_KEY, mode); sessionOverride = undefined } catch { sessionOverride = mode }
  applyThemeMode(mode)
  window.dispatchEvent(new Event(THEME_EVENT))
}
export function subscribeTheme(listener: () => void) {
  const update = () => { applyThemeMode(); listener() }
  const storage = (event: StorageEvent) => { if (event.key === THEME_STORAGE_KEY || event.key === null) { memoryMode = 'auto'; sessionOverride = undefined; update() } }
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  window.addEventListener(THEME_EVENT, update); window.addEventListener('storage', storage); media.addEventListener('change', update)
  return () => { window.removeEventListener(THEME_EVENT, update); window.removeEventListener('storage', storage); media.removeEventListener('change', update) }
}

/** Runs before styles/hydration in both the app and the independent password document. */
export const THEME_INIT_SCRIPT = `(function(){var r=document.documentElement,m='auto';try{var s=localStorage.getItem('theme');if(s==='light'||s==='dark'||s==='auto')m=s}catch(e){}var d=m==='dark'||(m==='auto'&&window.matchMedia('(prefers-color-scheme: dark)').matches);r.classList.add(d?'dark':'light');r.setAttribute('data-theme',d?'dark':'light');r.style.colorScheme=d?'dark':'light';if(location.pathname==='/secure-operation'){r.dataset.secureDocument='true';r.style.backgroundColor=d?'#202225':'#fff'}})();`
