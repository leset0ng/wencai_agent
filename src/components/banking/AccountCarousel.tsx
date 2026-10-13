import { Button } from '#/components/ui/button'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { BankCard } from '#/components/ui/BankCard'
import { Carousel, CarouselContent, CarouselItem, CarouselPrevious, CarouselNext } from '#/components/ui/carousel'
import type { DashboardData } from '#/lib/dashboard'

export function accountSlides(data: Pick<DashboardData, 'cards' | 'accounts'>) {
  return data.cards.filter((card) => data.accounts.some((account) => account.id === card.accountId))
}

export function AccountCarousel({ data, selectedId, onSelect, hidden }: {
  data: DashboardData; selectedId?: string; onSelect: (id: string) => void; hidden: boolean
}) {
  const slides = accountSlides(data)
  const index = Math.max(0, slides.findIndex((card) => card.id === selectedId))
  if (!slides.length) return <p className="bank-empty">你还没有银行账户</p>
  return <Carousel key={slides.map((card) => card.id).join('|')} value={index}
    onValueChange={(next) => { if (slides[next]) onSelect(slides[next].id) }}
    className="bank-account-carousel" aria-label="我的银行卡">
    <CarouselContent className="bank-card-viewport" tabIndex={0} aria-label="左右滑动切换银行卡，也可使用左右方向键">
      {slides.map((card, i) => <CarouselItem key={card.id} className="bank-card-slide"
        aria-label={`${i + 1} / ${slides.length} ${card.accountName}`} inert={i !== index}>
        <BankCard name={card.accountName} last4={card.last4} kind={card.kind} status={card.status}
          balance={card.kind === 'credit' ? card.availableCredit : data.accounts.find((account) => account.id === card.accountId)?.balance} hidden={hidden} />
      </CarouselItem>)}
    </CarouselContent>
    <div className="bank-card-controls">
      <CarouselPrevious className="bank-icon-button bank-lift" disabled={index === 0}><ChevronLeft size={18} /></CarouselPrevious>
      <div className="bank-card-dots">
        {slides.map((card, i) => <Button key={card.id} className="ui-button-reset" type="button"
          aria-label={`切换到${card.accountName}${card.last4 ? `尾号${card.last4}` : ''}`} aria-current={i === index ? 'true' : undefined}
          onClick={() => onSelect(card.id)}><span /></Button>)}
      </div>
      <span className="bank-card-count" aria-live="polite">{index + 1} / {slides.length}</span>
      <CarouselNext className="bank-icon-button bank-lift" disabled={index === slides.length - 1}><ChevronRight size={18} /></CarouselNext>
    </div>
  </Carousel>
}
