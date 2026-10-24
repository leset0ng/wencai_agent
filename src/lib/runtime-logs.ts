export type RuntimeLogLevel = 'info' | 'warn' | 'error'
export type RuntimeLogSource = 'http' | 'auth' | 'agent' | 'system'
export type RuntimeLogEntry = {
  id: number
  at: string
  level: RuntimeLogLevel
  source: RuntimeLogSource
  message: string
  requestId?: string
}
export type RuntimeLogSnapshot = {
  entries: RuntimeLogEntry[]
  capacity: number
  startedAt: string
}
