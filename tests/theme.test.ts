import { afterEach, describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { applyThemeMode, getThemeMode, resolveTheme, setThemeMode, subscribeTheme, THEME_INIT_SCRIPT, THEME_STORAGE_KEY } from '#/lib/theme'

afterEach(() => vi.unstubAllGlobals())
function browser(stored: string | null = null, systemDark = false, secure = false) {
  const classes = new Set<string>(), attributes = new Map<string, string>(), media = Object.assign(new EventTarget(), { matches: systemDark })
  const root = { classList: { add: (name: string) => classes.add(name), toggle: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name) },
    dataset: { secureDocument: secure ? 'true' : undefined }, style: { colorScheme: '', backgroundColor: '' }, setAttribute: (name: string, value: string) => attributes.set(name, value) }
  const values = new Map<string, string>(); if (stored) values.set(THEME_STORAGE_KEY, stored)
  const localStorage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
  const window = Object.assign(new EventTarget(), { localStorage, matchMedia: () => media })
  const document = { documentElement: root }, location = { pathname: secure ? '/secure-operation' : '/' }
  return { classes, attributes, media, root, localStorage, window, document, location }
}
describe('银行主题与独立安全文档同步', () => {
  it.each([['dark', false, 'dark'], ['light', true, 'light'], ['auto', true, 'dark'], ['auto', false, 'light'], [null, true, 'dark'], [null, false, 'light'], ['invalid', true, 'dark']] as const)('首次绘制%s，系统深色=%s，解析为%s', (stored, systemDark, expected) => {
    const context = browser(stored, systemDark, true)
    runInNewContext(THEME_INIT_SCRIPT, context)
    expect(context.classes.has(expected)).toBe(true)
    expect(context.attributes.get('data-theme')).toBe(expected)
    expect(context.root.style.colorScheme).toBe(expected)
    expect(context.root.style.backgroundColor).toBe(expected === 'dark' ? '#202225' : '#fff')
  })
  it('未选择主题时跟随手机系统即时变化，不写入手动偏好', () => {
    const context = browser(null, true), listener = vi.fn()
    vi.stubGlobal('window', context.window); vi.stubGlobal('document', context.document)
    expect(getThemeMode()).toBe('auto')
    applyThemeMode(); expect(context.classes.has('dark')).toBe(true)
    const unsubscribe = subscribeTheme(listener)
    context.media.matches = false; context.media.dispatchEvent(new Event('change'))
    expect(context.classes.has('light')).toBe(true)
    expect(context.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
    unsubscribe()
  })
  it('清除已保存的手动偏好后恢复跟随系统', () => {
    const context = browser(null, true)
    vi.stubGlobal('window', context.window); vi.stubGlobal('document', context.document)
    setThemeMode('light'); expect(getThemeMode()).toBe('light')
    context.localStorage.removeItem(THEME_STORAGE_KEY)
    expect(getThemeMode()).toBe('auto')
    applyThemeMode(); expect(context.classes.has('dark')).toBe(true)
  })
  it('设置后持久保存，切回白天模式移除dark，独立页面同步背景', () => {
    const context = browser('light', false, true)
    vi.stubGlobal('window', context.window); vi.stubGlobal('document', context.document)
    setThemeMode('dark')
    expect(context.localStorage.getItem('theme')).toBe('dark'); expect(context.classes.has('dark')).toBe(true)
    setThemeMode('light')
    expect(getThemeMode()).toBe('light'); expect(context.classes.has('dark')).toBe(false); expect(context.root.style.backgroundColor).toBe('#fff')
  })
  it('其他标签或父页面修改设置时，独立文档通过storage事件更新；卸载后不再监听', () => {
    const context = browser('light', false, true), listener = vi.fn()
    vi.stubGlobal('window', context.window); vi.stubGlobal('document', context.document)
    const unsubscribe = subscribeTheme(listener)
    context.localStorage.setItem('theme', 'dark')
    context.window.dispatchEvent(Object.assign(new Event('storage'), { key: 'theme' }))
    expect(context.classes.has('dark')).toBe(true); expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe(); context.localStorage.setItem('theme', 'light'); context.window.dispatchEvent(Object.assign(new Event('storage'), { key: 'theme' }))
    expect(listener).toHaveBeenCalledTimes(1)
  })
  it('跟随系统响应系统变化，显式白天设置不被系统深色覆盖', () => {
    const context = browser('auto'), listener = vi.fn()
    vi.stubGlobal('window', context.window); vi.stubGlobal('document', context.document)
    const unsubscribe = subscribeTheme(listener)
    context.media.matches = true; context.media.dispatchEvent(new Event('change'))
    expect(context.classes.has('dark')).toBe(true)
    setThemeMode('light'); context.media.dispatchEvent(new Event('change')); expect(context.classes.has('dark')).toBe(false)
    unsubscribe(); expect(resolveTheme('dark', false)).toBe('dark')
  })
  it('存储不可用时仍可切换，首屏脚本安全降级到系统主题', () => {
    const context = browser(null, true)
    context.localStorage.getItem = () => { throw new Error('Storage unavailable') }; context.localStorage.setItem = () => { throw new Error('Storage unavailable') }
    runInNewContext(THEME_INIT_SCRIPT, context); expect(context.classes.has('dark')).toBe(true)
    vi.stubGlobal('window', context.window); vi.stubGlobal('document', context.document)
    expect(() => setThemeMode('light')).not.toThrow(); expect(getThemeMode()).toBe('light')
    applyThemeMode(); expect(context.classes.has('light')).toBe(true)
  })
  it('已有偏好可读但写入失败时，本次选择不会被旧值覆盖', () => {
    const context = browser('dark')
    vi.stubGlobal('window', context.window); vi.stubGlobal('document', context.document)
    context.localStorage.setItem = () => { throw new Error('Quota exceeded') }
    setThemeMode('light'); applyThemeMode()
    expect(getThemeMode()).toBe('light'); expect(context.classes.has('dark')).toBe(false)
  })
})
