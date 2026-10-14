import { afterEach, describe, expect, it, vi } from 'vitest'
import { trackAgentKeyboard } from '#/lib/agent-keyboard'

afterEach(() => vi.unstubAllGlobals())

function browser(mobile = true) {
  const values = new Map<string, string>(), classes = new Set<string>()
  const viewport = Object.assign(new EventTarget(), { height: 896, offsetTop: 0, scale: 1 })
  const media = Object.assign(new EventTarget(), { matches: mobile })
  let rect = { left: 0, top: 0, bottom: 896, width: 414, height: 896 }
  let callback: FrameRequestCallback | undefined
  const window = Object.assign(new EventTarget(), {
    visualViewport: viewport, innerWidth: 414, matchMedia: () => media,
    requestAnimationFrame: (next: FrameRequestCallback) => { callback = next; return 1 },
    cancelAnimationFrame: () => { callback = undefined },
  })
  const document = { activeElement: null as null | { matches: (selector: string) => boolean } }
  const shell = Object.assign(new EventTarget(), {
    getBoundingClientRect: () => rect,
    style: { setProperty: (name: string, value: string) => values.set(name, value), removeProperty: (name: string) => values.delete(name) },
    classList: {
      add: (...names: string[]) => names.forEach((name) => classes.add(name)),
      remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
      toggle: (name: string, on: boolean) => on ? classes.add(name) : classes.delete(name),
    },
  })
  vi.stubGlobal('window', window); vi.stubGlobal('document', document)
  const flush = () => { const next = callback; callback = undefined; next?.(0) }
  const resize = (height: number, offsetTop = 0) => {
    viewport.height = height; viewport.offsetTop = offsetTop
    viewport.dispatchEvent(new Event('resize')); flush()
  }
  return { window, viewport, media, shell: shell as unknown as HTMLElement, values, classes, flush, resize,
    focus: () => { document.activeElement = { matches: (selector) => selector === '.bank-chat-composer input' } },
    blur: () => { document.activeElement = null },
    rect: (next: typeof rect) => { rect = next },
  }
}

describe('Agent 手机键盘布局', () => {
  it('进入面板不聚焦输入；键盘弹出后高度与顶部保持，只有底部留出遮挡距离', () => {
    const app = browser(), stop = trackAgentKeyboard(app.shell)
    expect(app.classes.has('bank-agent-keyboard')).toBe(false)
    app.focus()
    // Some browsers resize the layout viewport as well as the visual viewport.
    app.rect({ left: 0, top: 0, bottom: 550, width: 414, height: 550 })
    app.resize(550)
    expect(app.values.get('--agent-shell-height')).toBe('896px')
    expect(app.values.get('--agent-shell-top')).toBe('0px')
    expect(app.values.get('--agent-keyboard-inset')).toBe('346px')
    expect(app.classes.has('bank-agent-keyboard')).toBe(true)
    stop()
  })
  it('iOS 可视区域向上滚动时补偿顶部，不让标题被键盘引起的平移裁掉', () => {
    const app = browser(), stop = trackAgentKeyboard(app.shell)
    app.focus(); app.resize(550, 160)
    expect(app.values.get('--agent-shell-top')).toBe('160px')
    expect(app.values.get('--agent-keyboard-inset')).toBe('346px')
    app.viewport.offsetTop = 80; app.viewport.dispatchEvent(new Event('scroll')); app.flush()
    expect(app.values.get('--agent-shell-top')).toBe('80px')
    stop()
  })
  it('失焦时键盘尚未收起仍保留间距，收起后恢复；再次打开继续正确计算', () => {
    const app = browser(), stop = trackAgentKeyboard(app.shell)
    app.focus(); app.resize(550); app.blur(); app.resize(560)
    expect(app.values.get('--agent-keyboard-inset')).toBe('336px')
    app.resize(896)
    expect(app.classes.has('bank-agent-keyboard')).toBe(false)
    expect(app.values.get('--agent-keyboard-inset')).toBe('0px')
    app.focus(); app.resize(600)
    expect(app.values.get('--agent-keyboard-inset')).toBe('296px')
    stop()
  })
  it('浏览器工具栏的小幅变化、未输入时的窗口变化不会被当成键盘', () => {
    const app = browser(), stop = trackAgentKeyboard(app.shell)
    app.focus(); app.rect({ left: 0, top: 0, bottom: 840, width: 414, height: 840 }); app.resize(840)
    expect(app.classes.has('bank-agent-keyboard')).toBe(false)
    expect(app.values.get('--agent-shell-height')).toBe('840px')
    app.blur(); app.rect({ left: 0, top: 0, bottom: 500, width: 414, height: 500 }); app.resize(500)
    expect(app.classes.has('bank-agent-keyboard')).toBe(false)
    expect(app.values.get('--agent-shell-height')).toBe('500px')
    stop()
  })
  it('旋转到横屏后重算基准，桌面及双指缩放保留浏览器正常布局', () => {
    const app = browser(), stop = trackAgentKeyboard(app.shell)
    app.window.innerWidth = 896
    app.rect({ left: 218, top: 24, bottom: 390, width: 460, height: 366 }); app.resize(414)
    expect(app.values.get('--agent-shell-width')).toBe('460px')
    expect(app.values.get('--agent-shell-left')).toBe('218px')
    app.viewport.scale = 2; app.resize(200)
    expect(app.classes.size).toBe(0)
    app.viewport.scale = 1; app.media.matches = false; app.resize(414)
    expect(app.values.size).toBe(0)
    stop()
  })
  it('关闭后移除样式、监听和待处理帧，不影响首页或独立安全页', () => {
    const app = browser(), stop = trackAgentKeyboard(app.shell)
    app.focus(); app.resize(550)
    app.viewport.dispatchEvent(new Event('resize'))
    stop(); app.flush(); app.resize(600)
    expect(app.classes.size).toBe(0); expect(app.values.size).toBe(0)
  })
  it('不支持 VisualViewport 或桌面不启用键盘补偿', () => {
    const app = browser(false), stop = trackAgentKeyboard(app.shell)
    app.focus(); app.resize(550)
    expect(app.values.size).toBe(0)
    stop()
    vi.stubGlobal('window', { visualViewport: null })
    expect(() => trackAgentKeyboard(app.shell)()).not.toThrow()
  })
})
