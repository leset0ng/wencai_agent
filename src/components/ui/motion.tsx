import { animate, motion, useInView, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { formatAmount } from '#/lib/dashboard'
import './motion.css'

export const bankEase = [.2, .75, .2, 1] as const
export const motionStyle = (values: Record<`--${string}`, string | number>) => values as CSSProperties

/** Shared viewport trigger for home, tool receipts and generated Agent views. */
export function useReveal<T extends Element>() {
  const ref = useRef<T>(null)
  const visible = useInView(ref, { once: true, amount: .12 })
  const reduce = useReducedMotion()
  return { ref, 'data-visible': visible || !!reduce }
}

export function Reveal({ children, delay = 0, className = '' }: {
  children: ReactNode; delay?: number; className?: string
}) {
  const reveal = useReveal<HTMLDivElement>()
  const reduce = useReducedMotion()
  return <motion.div {...reveal} data-motion="reveal" className={`bank-reveal ${className}`}
    initial={false} animate={{ opacity: reveal['data-visible'] ? 1 : 0, y: reveal['data-visible'] ? 0 : 18 }}
    transition={{ duration: reduce ? 0 : .65, delay: reduce ? 0 : delay / 1000, ease: bankEase }}>
    {children}
  </motion.div>
}

export function AnimatedAmount({ value, prefix = '', className = '' }: {
  value: number; prefix?: string; className?: string
}) {
  const [display, setDisplay] = useState(value)
  const previous = useRef(0)
  const reduce = useReducedMotion()
  useEffect(() => {
    const from = previous.current
    previous.current = value
    if (reduce) { setDisplay(value); return }
    const controls = animate(from, value, { duration: .85, ease: bankEase, onUpdate: setDisplay })
    return () => controls.stop()
  }, [value, reduce])
  return <span className={className} aria-label={`${prefix}${formatAmount(value)}`}>
    <span aria-hidden="true">{prefix}{formatAmount(display)}</span>
  </span>
}

export function MotionMessage({ children, className }: { children: ReactNode; className?: string }) {
  const reduce = useReducedMotion()
  return <motion.div className={className} data-motion="message"
    initial={{ opacity: 0, y: 12, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
    transition={{ duration: reduce ? 0 : .38, ease: bankEase }}>{children}</motion.div>
}

export function ThinkingDots() {
  const reduce = useReducedMotion()
  return <>{[0, 1, 2].map((index) => <motion.i key={index} data-motion="dot"
    animate={reduce ? { y: 0, opacity: 1 } : { y: [0, -4, 0], opacity: [.45, 1, .45] }}
    transition={{ duration: 1, repeat: reduce ? 0 : Infinity, delay: index * .14 }} />)}</>
}

export function MotionPlot({ children, className }: { children: ReactNode; className?: string }) {
  const reduce = useReducedMotion()
  return <motion.div className={className} initial={{ clipPath: 'inset(0 100% 0 0)' }}
    whileInView={{ clipPath: 'inset(0 0% 0 0)' }} viewport={{ once: true, amount: .12 }}
    transition={{ duration: reduce ? 0 : .9, ease: bankEase }}>{children}</motion.div>
}
