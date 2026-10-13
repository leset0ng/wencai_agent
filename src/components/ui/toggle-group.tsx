import { ToggleGroup as ToggleGroupPrimitive } from '@base-ui/react/toggle-group'
import { Toggle as TogglePrimitive } from '@base-ui/react/toggle'
import type { ComponentProps } from 'react'
import { Button } from './button'

export function ToggleGroup({ value, onValueChange, ...props }: Omit<ToggleGroupPrimitive.Props, 'value' | 'onValueChange'> & {
  value: string; onValueChange: (value: string) => void
}) {
  return <ToggleGroupPrimitive data-slot="toggle-group" {...props} value={[value]}
    onValueChange={(values) => { if (values[0]) onValueChange(values[0]) }} />
}
export function ToggleGroupItem(props: ComponentProps<typeof TogglePrimitive>) {
  return <TogglePrimitive data-slot="toggle-group-item" render={<Button />} {...props} />
}
