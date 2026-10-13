import useEmblaCarousel from 'embla-carousel-react'
import { createContext, useContext, useEffect, useRef, type ComponentProps } from 'react'
import { useReducedMotion } from 'motion/react'
import { Button } from './button'

export type CarouselApi = NonNullable<ReturnType<typeof useEmblaCarousel>[1]>
const CarouselContext = createContext<{ viewport: ReturnType<typeof useEmblaCarousel>[0]; api?: CarouselApi } | null>(null)
function useCarousel() {
  const context = useContext(CarouselContext)
  if (!context) throw new Error('Carousel components must be inside Carousel')
  return context
}

/** shadcn's Embla foundation; controlled selection identifies the card and its ledger. */
export function Carousel({ value, onValueChange, children, ...props }: ComponentProps<'section'> & { value: number; onValueChange: (index: number) => void }) {
  const initial = useRef(value)
  const latest = useRef({ value, onValueChange })
  latest.current = { value, onValueChange }
  const [viewport, api] = useEmblaCarousel({ align: 'start', startIndex: initial.current, containScroll: 'trimSnaps', watchSlides: true })
  const reduce = useReducedMotion()
  useEffect(() => {
    if (!api) return
    const select = () => latest.current.onValueChange(api.selectedScrollSnap())
    const reInit = () => { api.scrollTo(latest.current.value, true); select() }
    api.on('select', select).on('reInit', reInit)
    return () => { api.off('select', select).off('reInit', reInit) }
  }, [api])
  useEffect(() => {
    if (api && api.selectedScrollSnap() !== value) api.scrollTo(value, !!reduce)
  }, [value, api, reduce])
  return <CarouselContext.Provider value={{ viewport, api }}>
    <section data-slot="carousel" aria-roledescription="轮播" {...props}
      onKeyDown={(event) => {
        props.onKeyDown?.(event)
        if (event.defaultPrevented) return
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          if (event.key === 'ArrowLeft') api?.scrollPrev(!!reduce)
          else api?.scrollNext(!!reduce)
        }
      }}>{children}</section>
  </CarouselContext.Provider>
}

export function CarouselContent({ children, ...props }: ComponentProps<'div'>) {
  const { viewport } = useCarousel()
  return <div ref={viewport} data-slot="carousel-content" {...props}><div className="ui-carousel-track">{children}</div></div>
}
export function CarouselItem(props: ComponentProps<'div'>) {
  return <div data-slot="carousel-item" role="group" aria-roledescription="卡片" {...props} />
}
export function CarouselPrevious(props: ComponentProps<typeof Button>) {
  const { api } = useCarousel()
  const reduce = useReducedMotion()
  return <Button aria-label="上一张银行卡" {...props} onClick={() => api?.scrollPrev(!!reduce)} />
}
export function CarouselNext(props: ComponentProps<typeof Button>) {
  const { api } = useCarousel()
  const reduce = useReducedMotion()
  return <Button aria-label="下一张银行卡" {...props} onClick={() => api?.scrollNext(!!reduce)} />
}
