import { createContext, useCallback, useContext, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Check } from 'lucide-react'
import { Button } from '#/components/ui/button'
import { BankCard } from '#/components/ui/BankCard'
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from '#/components/ui/carousel'
import { choiceDescription, choiceFromRow, confirmationMessage, SelectionDraft, type AgentChoice, type InteractionSnapshot, type AgentMessageOptions, type InteractionMemory } from './interaction-message'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '#/components/ui/table'
import './agent-interaction.css'
import { canonicalChoiceGroups, type ChoiceGroup } from './selection-groups'

export const AgentInteractionContext = createContext<{ send: (text: string, options?: AgentMessageOptions) => boolean | void; busy: boolean; enabled: boolean; snapshot: InteractionSnapshot; memory?: InteractionMemory }>({ send: () => {}, busy: true, enabled: false, snapshot: { requests: [], selections: [] } })
export const AgentChoiceContext = createContext<{
  register: (group: ChoiceGroup) => () => void; groups: ChoiceGroup[]; draft: SelectionDraft; hasChoices: boolean; securityConfirmation: boolean; host?: string; cancelled?: boolean; cancel?: () => void; confirm: (prompt?: string) => void
} | null>(null)

/** One interaction owns local choices and one submission. Security confirmations remain separate. */
export function AgentInteractionGroup({ children, active = true, securityConfirmation = false }: { children: ReactNode; active?: boolean; securityConfirmation?: boolean }) {
  const interaction = useContext(AgentInteractionContext), draft = useRef(new SelectionDraft()).current
  useSyncExternalStore(draft.subscribe, draft.getRevision, () => 0)
  const [groups, setGroups] = useState<ChoiceGroup[]>([])
  const [cancelled, setCancelled] = useState(false)
  const register = useCallback((group: ChoiceGroup) => {
    setGroups((previous) => [...previous.filter((item) => item.id !== group.id), group])
    setCancelled(false)
    return () => setGroups((previous) => previous.filter((item) => item.id !== group.id))
  }, [])
  const unique = canonicalChoiceGroups(groups)
  const host = unique.find((group) => group.choices[0]?.kind === 'card' && group.choices[0]?.slot === '付款卡')?.id ?? unique.find((group) => group.choices[0]?.kind === 'card')?.id
  const effective = new Map<string, AgentChoice[]>()
  for (const group of unique) {
    const slot = group.choices[0]?.slot ?? group.choices[0]?.kind
    if (slot) effective.set(slot, [...(effective.get(slot) ?? []), ...group.choices].filter((choice, index, all) => all.findIndex((item) => item.id === choice.id) === index))
  }
  const base = interaction.memory?.resolve(interaction.snapshot) ?? interaction.snapshot
  const current = new Map(unique.filter((group) => group.currentChoice).map((group) => [group.currentChoice!.slot ?? group.currentChoice!.kind, group.currentChoice!]))
  const chosen = [...effective.values()].map((choices) => current.get(choices[0].slot ?? choices[0].kind) ?? draft.selected(choices, base))
  const ready = chosen.length > 0 && chosen.every(Boolean)
  const confirm = (prompt?: string) => {
    if (!active || interaction.busy || securityConfirmation || (groups.length > 0 && !ready)) return
    const snapshot = draft.snapshot(base, chosen.filter((choice): choice is AgentChoice => !!choice))
    if (interaction.send(confirmationMessage(snapshot, [], prompt)) !== false) {
      chosen.filter((choice): choice is AgentChoice => !!choice).forEach((choice) => draft.select(choice))
      interaction.memory?.remember(snapshot)
      setCancelled(false)
    }
  }
  const cancel = () => { for (const slot of effective.keys()) draft.clear(slot); setCancelled(true) }
  return <AgentChoiceContext.Provider value={{ register, groups: unique, draft, hasChoices: unique.length > 0, securityConfirmation, host, cancelled, cancel, confirm }}>
    {children}
    {active && !securityConfirmation && groups.length > 0 && !host && <AgentSelectionConfirm />}
  </AgentChoiceContext.Provider>
}

function useChoiceGroup(choices: AgentChoice[], currentChoice?: AgentChoice) {
  const group = useContext(AgentChoiceContext), interaction = useContext(AgentInteractionContext), id = useId()
  const signature = JSON.stringify(choices.map((choice) => [choice.slot ?? choice.kind, choice.id]).sort())
  const serialized = JSON.stringify(choices)
  const current = JSON.stringify(currentChoice)
  useLayoutEffect(() => choices.length ? group?.register({ id, choices: JSON.parse(serialized), signature, currentChoice: current ? JSON.parse(current) : undefined }) : undefined, [group?.register, id, signature, serialized, current])
  const snapshot = interaction.memory?.resolve(interaction.snapshot) ?? interaction.snapshot
  const selected = group?.draft.selected(choices, snapshot)
  const owner = choices[0]?.kind === 'card' ? group?.groups.find((item) => item.choices[0]?.kind === 'card' && item.choices[0]?.slot === choices[0]?.slot)?.id : group?.groups.find((item) => item.signature === signature)?.id
  return { group, id, selected, visible: !group?.securityConfirmation && (!owner || owner === id), unique: choices.length === 1 }
}

export function AgentSelectionConfirm({ prompt, label = '确认' }: { prompt?: string; label?: string }) {
  const group = useContext(AgentChoiceContext), interaction = useContext(AgentInteractionContext)
  if (group?.securityConfirmation) return null
  const base = interaction.memory?.resolve(interaction.snapshot) ?? interaction.snapshot
  const slots = new Map<string, AgentChoice[]>()
  for (const item of group?.groups ?? []) for (const choice of item.choices) {
    const slot = choice.slot ?? choice.kind, values = slots.get(slot) ?? []
    if (!values.some((item) => item.id === choice.id)) slots.set(slot, [...values, choice])
  }
  const current = new Map((group?.groups ?? []).filter((item) => item.currentChoice).map((item) => [item.currentChoice!.slot ?? item.currentChoice!.kind, item.currentChoice!]))
  const choices = [...slots.values()].map((values) => current.get(values[0].slot ?? values[0].kind) ?? group?.draft.selected(values, base))
  const ready = choices.every(Boolean) && (!!prompt || choices.length > 0)
  return <section className="bank-selection-confirm" aria-label="确认办理选择">
    <p>{group?.cancelled ? '已取消本次选择，可调整后重新确认。' : choices.filter(Boolean).length ? `待确认：${choices.filter(Boolean).map((choice) => choiceDescription(choice!)).join('；')}` : prompt ? `确认后将发送：${prompt}` : '请先选择需要办理的对象'}</p>
    <div className="bank-agent-choice-actions">
      <Button type="button" className="bank-choice-button is-secondary" aria-label="取消" disabled={interaction.busy || !group} onClick={() => group?.cancel?.()}>取消</Button>
      <Button type="button" className="bank-choice-button" aria-label={label} disabled={interaction.busy || !ready} onClick={() => group ? group.confirm(prompt) : interaction.send(confirmationMessage(base, [], prompt))}>{label}</Button>
    </div>
  </section>
}

/** Selection only stages local state. The enclosing confirmation transmits the complete request. */
export function AgentActionButton({ label, choice, prompt, cancel = false, className = 'bank-choice-button', children, unique = false }: {
  label: string; choice?: AgentChoice; prompt?: string; cancel?: boolean; className?: string; children?: ReactNode; unique?: boolean
}) {
  const interaction = useContext(AgentInteractionContext), group = useContext(AgentChoiceContext)
  if (!choice) return group?.hasChoices ? null : <AgentSelectionConfirm prompt={prompt ?? label} label="确认" />
  const selected = group?.draft.selected([choice, { ...choice, id: '__unselected__' }], interaction.memory?.resolve(interaction.snapshot) ?? interaction.snapshot)?.id === choice.id
  const locked = unique || selected
  return <Button type="button" className={`${className}${locked && !cancel ? ' is-selected' : ''}`} aria-label={cancel ? label : locked ? `已选择${choice.label}` : label}
    disabled={interaction.busy || (!cancel && locked) || (cancel && unique) || !group} onClick={() => {
      if (cancel) group?.cancel?.()
      else group?.draft.select(choice)
    }}>{cancel ? children ?? label : locked ? <><Check size={14} />{unique ? '已确定' : '已选择'}</> : children ?? label}</Button>
}

export function AgentCardPicker({ choices: inputChoices, title = '我的银行卡', role }: { choices: AgentChoice[]; title?: string; role?: 'source' | 'target' | 'general' }) {
  const [index, setIndex] = useState(0), { snapshot } = useContext(AgentInteractionContext)
  const group = useContext(AgentChoiceContext)
  const purpose = role ?? snapshot.cardRole ?? (/(?:转账|转.{0,12}(?:元|块)|申购|投资|理财|付款|还款)/.test(snapshot.requests.join(' ')) ? 'source' : undefined)
  const normalized = inputChoices.map((choice) => ({ ...choice, slot: purpose === 'source' ? '付款卡' : purpose === 'target' ? '收款卡' : choice.slot ?? '银行卡' }))
  const choices = normalized.length ? group?.groups.find((item) => item.choices[0]?.kind === 'card' && item.choices[0]?.slot === normalized[0]?.slot)?.choices ?? normalized : normalized
  const choice = choices[Math.min(index, choices.length - 1)]
  const state = useChoiceGroup(normalized, choice)
  if (!state.visible) return null
  if (!choice) return state.group?.groups.some((group) => group.choices.some((item) => item.kind === 'card')) ? null : <p className="bank-choice-empty">暂无可选银行卡</p>
  const selected = choices.length === 1 || group?.draft.selected(choices, snapshot)?.id === choice.id
  return <section className={`bank-agent-choice${selected ? ' is-selected' : ''}`} aria-label={title}>
    <header><h3>{title}</h3><span aria-live="polite">{index + 1} / {choices.length}</span></header>
    <Carousel value={index} onValueChange={setIndex} className="bank-agent-card-picker" aria-label="选择银行卡">
      <CarouselContent className="bank-card-viewport" tabIndex={0} aria-label="左右滑动选择银行卡">
        {choices.map((item, i) => <CarouselItem key={item.id} className="bank-card-slide" inert={i !== index} aria-label={`${i + 1} / ${choices.length} 尾号${item.card?.last4}`}>
          <BankCard {...(item.card ?? { name: item.label })} active={i === index} />
        </CarouselItem>)}
      </CarouselContent>
      <CarouselPrevious className="bank-agent-card-prev" disabled={index === 0}><ChevronLeft size={19} /></CarouselPrevious>
      <CarouselNext className="bank-agent-card-next" disabled={index === choices.length - 1}><ChevronRight size={19} /></CarouselNext>
    </Carousel>
    <div className="bank-agent-choice-dots">{choices.map((item, i) => <Button key={item.id} className="ui-button-reset" aria-label={`切换到尾号${item.card?.last4}银行卡`} aria-current={index === i ? 'true' : undefined} onClick={() => setIndex(i)}><span /></Button>)}</div>
    <p className="bank-agent-choice-hint">{choices.length === 1 ? '已确定此银行卡' : '左右滑动切换银行卡，确认后提交当前卡片'}</p>
    {(!state.group || state.group.host === state.id) && <AgentSelectionConfirm />}
  </section>
}

export function AgentChoiceList({ choices, title = '请选择项目' }: { choices: AgentChoice[]; title?: string }) {
  if (choices.length && choices.every((choice) => choice.kind === 'card')) return <AgentCardPicker choices={choices} title={title} />
  return <ChoiceList choices={choices} title={title} />
}
function ChoiceList({ choices, title }: { choices: AgentChoice[]; title: string }) {
  const state = useChoiceGroup(choices)
  if (!state.visible || !choices.length) return null
  return <section className={`bank-agent-choice bank-agent-choice-list${state.unique ? ' is-fixed' : ''}`} aria-label={title}><header><h3>{title}</h3><span>{state.unique ? '已确定' : `${choices.length} 项`}</span></header>
    {choices.map((choice) => <div className={`bank-agent-choice-row${state.unique || state.selected?.id === choice.id ? ' is-selected' : ''}`} key={choice.id}><div><strong>{choice.label}</strong><p>{choice.details.map((field) => `${field.label} ${field.value}`).join(' · ')}</p></div><AgentActionButton label={`选择${choice.label}`} choice={choice} unique={state.unique}><span>选择</span></AgentActionButton></div>)}
  </section>
}

export function AgentSelectableTable({ rows, columns, title }: { rows: Record<string, unknown>[]; columns: { key: string; label: string }[]; title?: string }) {
  const choices = rows.map((row) => choiceFromRow(row))
  if (choices.length && choices.every((choice) => choice?.kind === 'card')) return <AgentCardPicker choices={choices as AgentChoice[]} title={title ?? '我的银行卡'} />
  return <SelectableTable rows={rows} choices={choices} columns={columns} title={title} />
}
function SelectableTable({ rows, choices, columns, title }: { rows: Record<string, unknown>[]; choices: (AgentChoice | null)[]; columns: { key: string; label: string }[]; title?: string }) {
  const valid = choices.filter((choice): choice is AgentChoice => !!choice), state = useChoiceGroup(valid)
  if (!state.visible && valid.length) return null
  return <div className="bank-gen-table bank-agent-options-table">{title && <h3>{title}</h3>}<Table><TableHeader><TableRow>
    {columns.map((column) => <TableHead key={column.key}>{column.label}</TableHead>)}{valid.length > 0 && <TableHead className="bank-choice-table-action">操作</TableHead>}
  </TableRow></TableHeader><TableBody>{rows.map((row, index) => <TableRow className={choices[index] && (state.unique || state.selected?.id === choices[index]?.id) ? 'is-selected' : undefined} key={choices[index]?.id ?? index} animated delay={Math.min(index, 10) * .05}>
    {columns.map((column) => <TableCell key={column.key}>{String(row[column.key] ?? '')}</TableCell>)}
    {valid.length > 0 && <TableCell className="bank-choice-table-action">{choices[index] && <AgentActionButton label={`选择${choices[index]!.label}`} choice={choices[index]!} unique={state.unique}><span>选择</span></AgentActionButton>}</TableCell>}
  </TableRow>)}</TableBody></Table></div>
}
