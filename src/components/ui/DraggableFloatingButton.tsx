import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { motion, useDragControls, useMotionValue, useReducedMotion } from 'motion/react'
import { Button } from './button'

/** Motion keeps the floating entry within its own bank shell, including after resize. */
export function DraggableFloatingButton({ children, hidden, expanded, controls, label, onActivate }: {
  children: ReactNode; hidden: boolean; expanded: boolean; controls: string; label: string; onActivate: () => void
}) {
  const anchor = useRef<HTMLDivElement>(null)
  const dragControls = useDragControls()
  const x = useMotionValue(0), y = useMotionValue(0)
  const [bounds, setBounds] = useState({ left: 0, right: 0, top: 0, bottom: 0 })
  const [dragging, setDragging] = useState(false)
  const suppressClick = useRef(false)
  const reduce = useReducedMotion()
  useLayoutEffect(() => {
    const element = anchor.current
    const parent = element?.offsetParent as HTMLElement | null
    if (!element || !parent) return
    const sync = () => {
      const minY = Math.min(32, Math.max(0, parent.clientHeight - element.offsetHeight))
      const left = 8 - element.offsetLeft
      const right = Math.max(left, parent.clientWidth - element.offsetWidth - 8 - element.offsetLeft)
      const top = minY - element.offsetTop
      const bottom = Math.max(top, parent.clientHeight - element.offsetHeight - 8 - element.offsetTop)
      setBounds({ left, right, top, bottom })
      x.set(Math.max(left, Math.min(x.get(), right)))
      y.set(Math.max(top, Math.min(y.get(), bottom)))
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [x, y])
  return <motion.div ref={anchor} data-motion="floating" className={`bank-floating-anchor${hidden ? ' is-hidden' : ''}${dragging ? ' is-dragging' : ''}`}
    style={{ x, y }} inert={hidden} drag dragListener={false} dragControls={dragControls}
    dragConstraints={bounds} dragElastic={0} dragMomentum={false}
    onDragStart={() => { suppressClick.current = true; setDragging(true) }}
    onDragEnd={() => setDragging(false)}>
    <Button animated={false} type="button" className="bank-agent-fab bank-lift" aria-label={label}
      aria-expanded={expanded} aria-controls={controls} title="拖动调整位置，点击打开文财"
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return
        suppressClick.current = false
        dragControls.start(event)
      }}
      onPointerCancel={() => { dragControls.cancel(); setDragging(false); suppressClick.current = true }}
      onClick={(event) => {
        if (suppressClick.current && event.detail !== 0) { event.preventDefault(); return }
        onActivate()
      }}
      render={<motion.button initial={false} animate={{ opacity: hidden ? 0 : 1, scale: hidden ? .65 : dragging ? 1.06 : 1 }}
        whileHover={!reduce && !dragging ? { y: -3 } : undefined} transition={{ duration: reduce ? 0 : .2 }} />}>
      {children}
    </Button>
  </motion.div>
}
