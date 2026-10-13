import type { ComponentProps } from 'react'
import { motion, useReducedMotion, type HTMLMotionProps } from 'motion/react'
import { cn } from '#/lib/utils'
import { useReveal, bankEase } from './motion'

export function Card({ className, ...props }: HTMLMotionProps<'section'>) {
  const reveal = useReveal<HTMLElement>()
  const reduce = useReducedMotion()
  return <motion.section {...reveal} data-slot="card" data-motion="card" className={cn(className ?? 'ui-card')}
    initial={false} animate={{ opacity: reveal['data-visible'] ? 1 : 0, y: reveal['data-visible'] ? 0 : 18 }}
    transition={{ duration: reduce ? 0 : .5, ease: bankEase }} {...props} />
}
export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card-header" className={cn(className ?? 'ui-card-header')} {...props} />
}
export function CardTitle({ className, ...props }: ComponentProps<'h2'>) {
  return <h2 data-slot="card-title" className={cn(className)} {...props} />
}
export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card-content" className={cn(className)} {...props} />
}
