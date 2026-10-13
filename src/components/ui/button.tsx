import { Button as ButtonPrimitive } from '@base-ui/react/button'
import { cva, type VariantProps } from 'class-variance-authority'
import { motion, useReducedMotion } from 'motion/react'
import type { ComponentProps } from 'react'
import { cn } from '#/lib/utils'

export const buttonVariants = cva('ui-button', {
  variants: {
    variant: {
      default: 'ui-button-primary',
      outline: 'ui-button-outline',
      ghost: 'ui-button-ghost',
      destructive: 'ui-button-destructive',
    },
    size: { default: 'ui-button-md', sm: 'ui-button-sm', icon: 'ui-button-icon' },
  },
  defaultVariants: { variant: 'default', size: 'default' },
})

type ButtonProps = ComponentProps<typeof ButtonPrimitive> & VariantProps<typeof buttonVariants> & {
  animated?: boolean
}

/** shadcn Base UI composition; existing className keeps the bank's visual skin. */
export function Button({ className, variant, size, animated = true, disabled, render, type = 'button', ...props }: ButtonProps) {
  const reduce = useReducedMotion()
  const interactive = animated && !disabled && !reduce
  return <ButtonPrimitive data-slot="button" type={type} disabled={disabled}
    className={cn(className !== undefined ? className : buttonVariants({ variant, size }))}
    render={render ?? <motion.button initial="rest" animate="rest" whileHover={interactive ? 'hover' : undefined}
      whileFocus={interactive ? 'hover' : undefined}
      whileTap={interactive ? 'pressed' : undefined}
      variants={{ rest: { y: 0, scale: 1 }, hover: { y: -3 }, pressed: { scale: .97, y: -1 } }}
      transition={{ type: 'spring', stiffness: 420, damping: 30 }} />}
    {...props} />
}
