import { MotionConfig } from 'motion/react'
import type { ReactNode } from 'react'
import { bankEase } from './motion'
import { SecureOperationProvider } from './SecureOperation'
import { ThemeProvider } from './ThemeProvider'

export function UIProvider({ children }: { children: ReactNode }) {
  return <ThemeProvider><MotionConfig reducedMotion="user" transition={{ duration: .26, ease: bankEase }}><SecureOperationProvider>{children}</SecureOperationProvider></MotionConfig></ThemeProvider>
}
