import { useState } from 'react'
import { BankCard } from '#/components/ui/BankCard'
import { Carousel, CarouselContent, CarouselItem } from '#/components/ui/carousel'
import type { AgentChoice } from './interaction-message'
import './agent-interaction.css'

/** A query display: no draft registration, selection, confirmation, or card-number action. */
export function AgentCardDisplay({ choices, title = '银行卡信息', cardIds }: { choices: AgentChoice[]; title?: string; cardIds?: string[] }) {
  const [index, setIndex] = useState(0)
  const cards = choices.filter(choice => choice.card && (!cardIds?.length || cardIds.includes(choice.id)))
  if (!cards.length) return <p className="bank-choice-empty">暂无符合条件的银行卡</p>
  const selected = Math.min(index, cards.length - 1)
  return <section className="bank-agent-choice bank-agent-card-display" aria-label={title}>
    <header><h3>{title}</h3><span aria-live="polite">{selected + 1} / {cards.length}</span></header>
    <Carousel key={cards.map(card => card.id).join('|')} value={selected} onValueChange={setIndex} className="bank-agent-card-picker" aria-label="浏览银行卡">
      <CarouselContent className="bank-card-viewport" tabIndex={0} aria-label="左右滑动或使用方向键浏览银行卡">
        {cards.map((choice, i) => <CarouselItem key={choice.id} className="bank-card-slide" inert={i !== selected} aria-label={`尾号${choice.card?.last4}`}>
          <BankCard {...choice.card!} cardId={undefined} active={i === selected} />
        </CarouselItem>)}
      </CarouselContent>
    </Carousel>
    {cards.length > 1 && <><div className="bank-agent-choice-dots" aria-hidden="true">{cards.map((card, i) => <span key={card.id} className={i === selected ? 'is-current' : ''} />)}</div><p className="bank-agent-choice-hint">左右滑动浏览银行卡</p></>}
  </section>
}
