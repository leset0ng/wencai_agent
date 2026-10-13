import type { AgentChoice } from './interaction-message'
export interface ChoiceGroup { id: string; choices: AgentChoice[]; signature: string; currentChoice?: AgentChoice }

/** One visible carousel per card role; prefer an eligible subset over the general card query. */
export function canonicalChoiceGroups(groups: ChoiceGroup[]) {
  const result: ChoiceGroup[] = [], visited = new Set<string>()
  for (const group of groups) {
    if (!group.choices.length) continue
    const first = group.choices[0], key = first.kind === 'card' ? `card:${first.slot ?? first.kind}` : group.signature
    if (visited.has(key)) continue
    visited.add(key)
    if (first.kind !== 'card') { result.push(group); continue }
    const peers = groups.filter((item) => item.choices[0]?.kind === 'card' && (item.choices[0]?.slot ?? item.choices[0]?.kind) === (first.slot ?? first.kind))
    const subset = peers.filter((candidate) => peers.every((other) => candidate.choices.every((choice) => other.choices.some((item) => item.id === choice.id))))
      .sort((a,b) => a.choices.length - b.choices.length)[0]
    if (subset) result.push(subset)
    else {
      const choices = peers.flatMap((item) => item.choices).filter((choice,index,all) => all.findIndex((item) => item.id === choice.id) === index)
      result.push({ ...group, choices })
    }
  }
  return result
}
