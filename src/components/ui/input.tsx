import { Input as InputPrimitive } from '@base-ui/react/input'
import type { ComponentProps } from 'react'
import { cn } from '#/lib/utils'

export function Input({ className, ...props }: ComponentProps<typeof InputPrimitive>) {
  return <InputPrimitive data-slot="input" className={cn('ui-input', className)} {...props} />
}
