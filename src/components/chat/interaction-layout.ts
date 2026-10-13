type Element = { type: string; props?: Record<string, unknown>; children?: string[] }
type ViewSpec = { root: string; elements: Record<string, Element>; state?: Record<string, unknown> }
/** Remove obsolete per-card follow-ups and their empty wrapper panels. */
export function selectionView(spec: ViewSpec, otherSelectors = false, securityConfirmation = false): ViewSpec | null {
  const reachable = new Set<string>()
  const walk = (id: string) => { if (reachable.has(id)) return; reachable.add(id); spec.elements[id]?.children?.forEach(walk) }
  walk(spec.root)
  const selectors = otherSelectors || [...reachable].some((id) => ['CardPicker', 'ChoiceList'].includes(spec.elements[id]?.type))
  if (!selectors) return spec
  const elements: Record<string, Element> = {}, seen = new Set<string>(), visited = new Set<string>()
  const visit = (id: string): boolean => {
    const element = spec.elements[id]
    if (visited.has(id)) return false
    visited.add(id)
    if (!element || ['FollowUp', 'Confirm'].includes(element.type)) return false
    if (securityConfirmation && ['CardPicker', 'ChoiceList'].includes(element.type)) return false
    if (['CardPicker', 'ChoiceList', 'Table'].includes(element.type)) {
      const key = JSON.stringify([element.type, element.props?.data ?? element.props?.rows, element.props?.role])
      if (seen.has(key)) return false
      seen.add(key)
    }
    const children = (element.children ?? []).filter(visit)
    if (element.type === 'Panel' && element.children?.length && !children.length) return false
    if (element.type === 'Panel' && children.length === 1 && ['CardPicker', 'ChoiceList'].includes(elements[children[0]]?.type)) {
      elements[id] = elements[children[0]]
      return true
    }
    elements[id] = { ...element, children }
    return true
  }
  return visit(spec.root) ? { ...spec, elements } : null
}
