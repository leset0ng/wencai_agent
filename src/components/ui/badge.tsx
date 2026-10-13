import type { ComponentProps } from 'react'
import { cn } from '#/lib/utils'

export function Badge({ className, ...props }: ComponentProps<'span'>) {
  return <span data-slot="badge" className={cn(className ?? 'ui-badge')} {...props} />
}
