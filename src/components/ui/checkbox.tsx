import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox'
import { Check } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import type { ComponentProps } from 'react'
import { cn } from '#/lib/utils'

export function Checkbox({ className, ...props }: ComponentProps<typeof CheckboxPrimitive.Root>) {
  const reduce = useReducedMotion()
  return <CheckboxPrimitive.Root data-slot="checkbox" className={cn('ui-checkbox', className)} {...props}>
    <CheckboxPrimitive.Indicator render={<motion.span initial={reduce ? false : { opacity: 0, scale: .6 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: reduce ? 0 : .16 }} />}>
      <Check size={12} strokeWidth={3} />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
}
