import { motion, useReducedMotion, type HTMLMotionProps } from 'motion/react'
import type { ComponentProps } from 'react'
import { cn } from '#/lib/utils'
import { bankEase } from './motion'

// shadcn's native table semantics, with no extra wrapper that changes existing layouts.
export function Table({ className, ...props }: ComponentProps<'table'>) { return <table data-slot="table" className={cn(className)} {...props} /> }
export function TableHeader(props: ComponentProps<'thead'>) { return <thead data-slot="table-header" {...props} /> }
export function TableBody(props: ComponentProps<'tbody'>) { return <tbody data-slot="table-body" {...props} /> }
export function TableHead(props: ComponentProps<'th'>) { return <th data-slot="table-head" {...props} /> }
export function TableCell(props: ComponentProps<'td'>) { return <td data-slot="table-cell" {...props} /> }
export function TableRow({ delay = 0, animated = false, ...props }: HTMLMotionProps<'tr'> & { delay?: number; animated?: boolean }) {
  const reduce = useReducedMotion()
  return <motion.tr data-slot="table-row" initial={animated ? { opacity: 0, y: 5 } : false}
    whileInView={animated ? { opacity: 1, y: 0 } : undefined} viewport={{ once: true }}
    transition={{ duration: reduce ? 0 : .3, delay: reduce ? 0 : delay, ease: bankEase }} {...props} />
}
