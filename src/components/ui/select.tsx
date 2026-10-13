import { Select as SelectPrimitive } from '@base-ui/react/select'
import { Check, ChevronDown } from 'lucide-react'
import { Children, isValidElement, useState, type ComponentProps, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { cn } from '#/lib/utils'

type OptionProps = { value: string; children: ReactNode; disabled?: boolean }
/** Declarative options are read by SelectControl, never rendered as native options. */
export function SelectOption(_props: OptionProps) { return null }

type SelectControlProps = Pick<SelectPrimitive.Root.Props<string>, 'value' | 'defaultValue' | 'name' | 'required' | 'disabled' | 'id'> & {
  onValueChange?: (value: string) => void
  children: ReactNode
  className?: string
  'aria-label'?: string
  'aria-labelledby'?: string
}

/** Compact shadcn-style composition with Base UI keyboard/typeahead/form behavior. */
export function SelectControl({ children, className, 'aria-label': label, 'aria-labelledby': labelledBy, onValueChange, ...props }: SelectControlProps) {
  const [open, setOpen] = useState(false)
  const reduce = useReducedMotion()
  const items = Children.toArray(children).flatMap((child) =>
    isValidElement<OptionProps>(child) && child.type === SelectOption
      ? [{ value: child.props.value, label: child.props.children, disabled: child.props.disabled || (!!props.required && child.props.value === '') }]
      : [],
  )
  return <SelectPrimitive.Root {...props} items={items} open={open} onOpenChange={setOpen} onValueChange={(value) => onValueChange?.(value ?? '')}>
    <SelectPrimitive.Trigger data-slot="select-trigger" className={cn('ui-select-trigger', className)} aria-label={label} aria-labelledby={labelledBy}>
      <SelectPrimitive.Value /><SelectPrimitive.Icon><ChevronDown size={15} /></SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner sideOffset={6} alignItemWithTrigger={false} className="ui-select-positioner">
        <SelectPrimitive.Popup data-slot="select-content" className="ui-select-content"
          render={<motion.div initial={reduce ? false : { opacity: 0, y: -5, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: reduce ? 0 : .16 }} />}>
          <SelectPrimitive.List>
            {items.map((item) => <SelectPrimitive.Item key={item.value} value={item.value} disabled={item.disabled} className="ui-select-item">
              <SelectPrimitive.ItemText>{item.label}</SelectPrimitive.ItemText>
              <SelectPrimitive.ItemIndicator><Check size={14} /></SelectPrimitive.ItemIndicator>
            </SelectPrimitive.Item>)}
          </SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  </SelectPrimitive.Root>
}

export const Select = SelectPrimitive.Root
export const SelectTrigger = SelectPrimitive.Trigger
export const SelectValue = SelectPrimitive.Value
export const SelectItem = SelectPrimitive.Item
export type SelectTriggerProps = ComponentProps<typeof SelectPrimitive.Trigger>
