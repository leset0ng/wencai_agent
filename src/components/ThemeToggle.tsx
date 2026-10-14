import { Sun, Moon, Monitor } from 'lucide-react'
import { Button } from '#/components/ui/button'
import { useThemeMode } from '#/components/ui/ThemeProvider'
import { setThemeMode, type ThemeMode } from '#/lib/theme'

const modes = [
  { value: 'light', label: '白天模式', icon: Sun },
  { value: 'dark', label: '黑夜模式', icon: Moon },
  { value: 'auto', label: '跟随系统', icon: Monitor },
] as const
export function ThemeSelector() {
  const mode = useThemeMode()
  return <div className="bank-theme-selector" role="group" aria-label="外观模式">{modes.map(({ value, label, icon: Icon }) =>
    <Button key={value} className="bank-theme-option" type="button" aria-pressed={mode === value} onClick={() => setThemeMode(value)}><Icon size={21} /><span>{label}</span></Button>)}</div>
}
export default function ThemeToggle() {
  const mode = useThemeMode(), current = modes.find((item) => item.value === mode)!, Icon = current.icon
  const next: ThemeMode = mode === 'light' ? 'dark' : mode === 'dark' ? 'auto' : 'light'
  return <Button type="button" className="bank-theme-toggle" aria-label={`当前${current.label}，切换为${modes.find((item) => item.value === next)!.label}`} onClick={() => setThemeMode(next)}><Icon size={16} /><span>{current.label}</span></Button>
}
