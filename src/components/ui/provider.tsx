import { MotionConfig } from 'motion/react'
import type { ReactNode } from 'react'
import { bankEase } from './motion'

export function UIProvider({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user" transition={{ duration: .26, ease: bankEase }}>{children}</MotionConfig>
}
