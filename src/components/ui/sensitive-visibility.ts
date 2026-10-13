import { createContext } from 'react'
/** Persistent sheets must clear revealed secrets as soon as they close. */
export const SensitiveVisibility = createContext(true)
