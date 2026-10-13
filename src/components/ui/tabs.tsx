import { Tabs as TabsPrimitive } from '@base-ui/react/tabs'
import type { ComponentProps } from 'react'
import { Button } from './button'

export const Tabs = TabsPrimitive.Root
export const TabsList = TabsPrimitive.List
export function TabsTrigger(props: ComponentProps<typeof TabsPrimitive.Tab>) {
  return <TabsPrimitive.Tab data-slot="tabs-trigger" render={<Button />} {...props} />
}
export const TabsContent = TabsPrimitive.Panel
