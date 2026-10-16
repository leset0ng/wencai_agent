import { Dialog } from '@base-ui/react/dialog'
import { motion, useDragControls, useReducedMotion } from 'motion/react'
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Button } from './button'
import { useDesktopLayout } from '#/lib/use-desktop-layout'
import './desktop-security.css'

/** The parent owns the sheet gesture; the separate document owns secret inputs. */
export function SecureSheet({ open, height, frame, onCancel, children }: {
  open: boolean; height: number; frame: RefObject<HTMLIFrameElement | null>; onCancel: () => void; children: ReactNode
}) {
  const controls = useDragControls(), reduce = useReducedMotion()
  const desktop = useDesktopLayout()
  const panel = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState({ left: '50%', width: 460, bottom: 0, maxHeight: 900 })
  useLayoutEffect(() => {
    if (!open) return
    const shell = document.querySelector('.bank-shell')
    const update = () => {
      const rect = shell?.getBoundingClientRect()
      const viewport = window.visualViewport
      const screenHeight = viewport?.height ?? window.innerHeight
      const bottom = rect ? Math.max(0, screenHeight - rect.bottom) : 0
      setAnchor({ left: desktop ? '50%' : rect ? `${rect.left + rect.width / 2}px` : '50%', width: desktop ? Math.min(940, window.innerWidth - 64) : Math.min(rect?.width ?? 460, window.innerWidth), bottom, maxHeight: Math.max(180, Math.min(rect?.height ?? screenHeight, screenHeight - bottom) - (desktop ? 64 : 12)) })
    }
    update()
    const observer = new ResizeObserver(update)
    if (shell) observer.observe(shell)
    window.addEventListener('resize', update); window.visualViewport?.addEventListener('resize', update)
    return () => { observer.disconnect(); window.removeEventListener('resize', update); window.visualViewport?.removeEventListener('resize', update) }
  }, [open, desktop])
  return <Dialog.Root open={open} disablePointerDismissal onOpenChange={(next, details) => { if (!next && details.reason === 'escape-key') onCancel() }}>
    <Dialog.Portal>
      <Dialog.Backdrop className={`bank-secure-backdrop${open ? ' is-open' : ''}`} render={<motion.div initial={false} animate={{ opacity: open ? 1 : 0 }} transition={{ duration: reduce ? 0 : .24 }} />} />
      <Dialog.Popup ref={panel} hidden={false} inert={!open} aria-hidden={!open} className={`bank-secure-frame${desktop ? ' bank-secure-desktop-frame' : ''}${open ? ' is-open' : ''}`}
        initialFocus={() => frame.current} style={{ left: anchor.left, width: anchor.width, bottom: desktop ? '50%' : anchor.bottom }}
        render={<motion.div initial={reduce ? false : { y: desktop ? 'calc(50% + 16px)' : '105%' }} animate={{ y: desktop ? open ? '50%' : 'calc(50% + 16px)' : open ? '0%' : '105%', opacity: open ? 1 : 0, height: Math.min(height + (desktop ? 2 : 24), anchor.maxHeight) }}
          style={{ x: '-50%' }} transition={{ duration: reduce ? 0 : .32, ease: [.22, 1, .36, 1] }}
          drag={desktop ? false : 'y'} dragListener={false} dragControls={controls} dragConstraints={{ top: 0, bottom: 0 }} dragElastic={{ top: 0, bottom: .8 }} dragMomentum={false}
          onDragEnd={(_, info) => { if (info.offset.y > Math.min(100, (panel.current?.clientHeight ?? 500) * .2) || (info.offset.y > 30 && info.velocity.y > 650)) onCancel() }} />}>
        <Dialog.Title className="sr-only">银行卡安全验证独立页面</Dialog.Title>
        {!desktop && <Button animated={false} className="bank-secure-grip" aria-label="下拉收起安全验证" onPointerDown={(event) => {
          if (open && event.isPrimary && event.button === 0) {
            // Keep receiving drag events when the pointer crosses the iframe below.
            event.currentTarget.setPointerCapture(event.pointerId); controls.start(event)
          }
        }} onClick={(event) => { if (event.detail === 0) onCancel() }}><span /></Button>}
        {children}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
}
