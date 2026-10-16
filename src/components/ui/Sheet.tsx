import { Dialog } from '@base-ui/react/dialog'
import { motion, useDragControls, useReducedMotion } from 'motion/react'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button } from './button'
import { bankEase } from './motion'
import { SensitiveVisibility } from './sensitive-visibility'
import { useDesktopLayout } from '#/lib/use-desktop-layout'

/** Base UI manages focus/Escape; Motion owns the persistent panel and grip gesture. */
export function Sheet({ open, onClose, title, children, className = '', header, headerActions, responsiveSide = false, portalContainer }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; className?: string; header?: ReactNode; headerActions?: ReactNode; responsiveSide?: boolean; portalContainer?: HTMLElement|null
}) {
  const desktop = useDesktopLayout()
  const side = desktop && responsiveSide
  const anchor = useRef<HTMLSpanElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const controls = useDragControls()
  const reduce = useReducedMotion()
  useLayoutEffect(() => { setContainer(portalContainer ?? anchor.current?.parentElement ?? null) }, [portalContainer])
  return <>
    <span ref={anchor} hidden />
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose() }} modal={side ? false : 'trap-focus'} disablePointerDismissal={side}>
      {container && <Dialog.Portal container={container} keepMounted>
        {!side && <Dialog.Backdrop data-motion="sheet-backdrop" className={`bank-sheet-backdrop${open ? ' is-open' : ''}`}
          render={<motion.div initial={false} animate={{ opacity: open ? 1 : 0 }} transition={{ duration: reduce ? 0 : .35 }} />} />}
        <Dialog.Popup ref={panel} data-motion="sheet" hidden={false} inert={!open} aria-hidden={!open} aria-modal={open && !side ? true : undefined}
          className={`bank-sheet ${className}${side ? ' bank-side-sheet' : ''}${open ? ' is-open' : ''}`}
          initialFocus={() => panel.current?.querySelector<HTMLElement>('[data-autofocus]') ?? panel.current}
          render={<motion.div initial={false} animate={{ x: side && !open ? '110%' : '0%', y: !side && !open ? '105%' : '0%' }}
            transition={{ duration: reduce ? 0 : .55, ease: bankEase }}
            drag={side ? false : 'y'} dragListener={false} dragControls={controls} dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 1 }} dragMomentum={false}
            onDragEnd={(_, info) => {
              const distance = Math.max(0, info.offset.y)
              const threshold = Math.min(110, (panel.current?.clientHeight ?? 500) * .2)
              if (distance >= threshold || (distance >= 32 && info.velocity.y > 650)) onClose()
            }} />}>
          <Button animated={false} type="button" className="bank-sheet-grip" aria-label={`下拉收起${title}`}
            onPointerDown={(event) => { if (open && event.isPrimary && event.button === 0) controls.start(event) }}
            onClick={(event) => { if (event.detail === 0) onClose() }}><span className="bank-sheet-handle" /></Button>
          <header className="bank-sheet-heading">
            <Dialog.Title render={<div />}>{header ?? <h2>{title}</h2>}</Dialog.Title>
            {headerActions}
            <Dialog.Close render={<Button className="bank-icon-button bank-lift" aria-label={`关闭${title}`} />}><X size={21} /></Dialog.Close>
          </header>
          <SensitiveVisibility.Provider value={open}>{children}</SensitiveVisibility.Provider>
        </Dialog.Popup>
      </Dialog.Portal>}
    </Dialog.Root>
  </>
}
