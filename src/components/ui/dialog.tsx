import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { motion, useReducedMotion } from 'motion/react'
import type { ComponentProps } from 'react'
import { cn } from '#/lib/utils'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close
export const DialogTitle = DialogPrimitive.Title
export const DialogDescription = DialogPrimitive.Description

export function DialogContent({ className, children, ...props }: ComponentProps<typeof DialogPrimitive.Popup>) {
  const reduce = useReducedMotion()
  return <DialogPrimitive.Portal>
    <DialogPrimitive.Backdrop className="dialog-overlay" render={<motion.div initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduce ? 0 : .22 }} />} />
    <DialogPrimitive.Popup {...props} data-slot="dialog-content" className={cn('dialog-content', className)}
      render={<motion.div initial={reduce ? false : { opacity: 0, scale: .96, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }}
        style={{ x: '-50%', translateY: '-50%' }} transition={{ duration: reduce ? 0 : .22 }} />}>
      {children}
    </DialogPrimitive.Popup>
  </DialogPrimitive.Portal>
}
