import { createElement, type ComponentProps, type ReactElement, type RefObject } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HTMLMotionProps, PanInfo } from 'motion/react'
import { Dialog } from '@base-ui/react/dialog'
import { SecureSheet } from '#/components/ui/SecureSheet'
import { AgentCardPicker } from '#/components/chat/AgentInteraction'
import type { AgentChoice } from '#/components/chat/interaction-message'

const captured = vi.hoisted(() => ({
  content: undefined as ComponentProps<typeof Dialog.Popup> | undefined,
  start: vi.fn(),
  reduced: false,
}))

// Exercise the component's public layout and gesture contract without a browser or database.
vi.mock('@base-ui/react/dialog', async () => {
  const { createElement } = await import('react')
  return {
    Dialog: {
    Root: ({ children }: { children: React.ReactNode }) => createElement('div', {}, children),
    Portal: ({ children }: { children: React.ReactNode }) => createElement('div', {}, children),
    Backdrop: () => null,
    Title: ({ children }: { children: React.ReactNode }) => createElement('h2', {}, children),
    Popup: (props: ComponentProps<typeof Dialog.Popup>) => {
      captured.content = props
      return createElement('div', {}, props.children)
    } },
  }
})
vi.mock('motion/react', async (original) => ({
  ...await original<typeof import('motion/react')>(),
  useReducedMotion: () => captured.reduced,
  useDragControls: () => ({ start: captured.start }),
}))
vi.mock('#/components/ui/BankCard', async () => {
  const { createElement } = await import('react')
  return { BankCard: ({ cardId, active }: { cardId: string; active?: boolean }) => createElement('div', { 'data-card-id': cardId, 'data-active': String(active) }) }
})

function sheet(open = true) {
  const onCancel = vi.fn()
  const frame = { current: null } as RefObject<HTMLIFrameElement | null>
  renderToStaticMarkup(createElement(SecureSheet, { open, height: 328, frame, onCancel, children: null }))
  const content = captured.content!
  const grip = (content.children as ReactElement<ComponentProps<'button'>>[]).find((element) => element?.props?.['aria-label'] === '下拉收起安全验证')!
  const motion = content.render as ReactElement<HTMLMotionProps<'div'> & { ref: RefObject<HTMLDivElement | null> }>
  return { content, grip, motion, onCancel, frame }
}
const pan = (offset: number, velocity = 0): PanInfo => ({ offset: { x: 0, y: offset }, velocity: { x: 0, y: velocity }, delta: { x: 0, y: 0 }, point: { x: 0, y: 0 } })

beforeEach(() => { captured.content = undefined; captured.start.mockClear(); captured.reduced = false })

describe('安全面板与选卡隐私恢复', () => {
  it('只使用一次横向居中并覆盖通用弹窗最大宽度', () => {
    const { content } = sheet()
    expect(content.style).toMatchObject({ left: '50%', width: 460, maxWidth: 'none' })
    expect(content.style).not.toHaveProperty('marginLeft')
    const { motion } = sheet()
    expect(motion.props.style).toMatchObject({ x: '-50%' })
    expect(content.style).not.toHaveProperty('transform')
  })
  it('手柄启动拖动前捕获主指针，其他指针与关闭状态不启动', () => {
    const { grip } = sheet()
    const setPointerCapture = vi.fn()
    const event = { isPrimary: true, button: 0, pointerId: 7, currentTarget: { setPointerCapture } } as unknown as React.PointerEvent<HTMLButtonElement>
    grip.props.onPointerDown?.(event)
    expect(setPointerCapture).toHaveBeenCalledWith(7)
    expect(captured.start).toHaveBeenCalledWith(event)
    grip.props.onPointerDown?.({ ...event, isPrimary: false })
    grip.props.onPointerDown?.({ ...event, button: 2 })
    sheet(false).grip.props.onPointerDown?.(event)
    expect(captured.start).toHaveBeenCalledTimes(1)
  })
  it('下拉超过高度阈值或足够距离的快速下甩才取消', () => {
    const { content, motion, onCancel } = sheet()
    expect(motion.props).toMatchObject({ drag: 'y', dragListener: false, dragMomentum: false, dragConstraints: { top: 0, bottom: 0 } })
    ;(content.ref as RefObject<HTMLDivElement | null>).current = { clientHeight: 400 } as HTMLDivElement
    motion.props.onDragEnd?.({} as PointerEvent, pan(79))
    motion.props.onDragEnd?.({} as PointerEvent, pan(-150, -1000))
    motion.props.onDragEnd?.({} as PointerEvent, pan(20, 1000))
    expect(onCancel).not.toHaveBeenCalled()
    motion.props.onDragEnd?.({} as PointerEvent, pan(81))
    motion.props.onDragEnd?.({} as PointerEvent, pan(31, 651))
    expect(onCancel).toHaveBeenCalledTimes(2)
  })
  it('键盘取消仍有效，普通手柄点击不意外取消；减弱动态保留手势', () => {
    captured.reduced = true
    const { grip, motion, onCancel } = sheet()
    grip.props.onClick?.({ detail: 1 } as React.MouseEvent<HTMLButtonElement>)
    expect(onCancel).not.toHaveBeenCalled()
    grip.props.onClick?.({ detail: 0 } as React.MouseEvent<HTMLButtonElement>)
    expect(onCancel).toHaveBeenCalledOnce()
    expect(motion.props.drag).toBe('y')
  })
  it('只有当前卡片可保持完整卡号可见状态', () => {
    const choices: AgentChoice[] = ['1111', '2222'].map((last4) => ({ id: last4, kind: 'card', label: '储蓄卡', details: [], card: { cardId: last4, name: '储蓄卡', last4 } }))
    const markup = renderToStaticMarkup(createElement(AgentCardPicker, { choices }))
    expect(markup).toContain('data-card-id="1111" data-active="true"')
    expect(markup).toContain('data-card-id="2222" data-active="false"')
  })
})
