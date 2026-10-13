import { Wifi } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { bankEase, useReveal } from './motion'
import { formatAmount } from '#/lib/dashboard'
import './bank-card.css'
import { CardNumber } from './CardNumber'
import './bank-security.css'

export function BankCardStack({ count = 3 }: { count?: number }) {
  const reveal = useReveal<HTMLSpanElement>()
  const reduce = useReducedMotion()
  return (
    <span {...reveal} className="bank-card-stack" aria-hidden="true">
      {Array.from({ length: Math.max(0, count) }, (_, index) => index)
        .reverse()
        .map((index) => (
          <motion.span key={index} data-motion="stack-card" className={`bank-stack-card stack-${index}`} style={{
            left: `${count > 1 ? index * 28 / (count - 1) : 0}px`,
            top: `${30 - (count > 1 ? index * 26 / (count - 1) : 0)}px`,
            opacity: `${1 - (count > 1 ? index * .45 / (count - 1) : 0)}`,
          }}
            initial={{ x: 15, y: 20, z: -90, rotateY: -25 }}
            animate={reveal['data-visible'] ? { x: 0, y: 0, z: 0, rotateY: 0, rotate: index === 0 ? -6 : 2 + index } : undefined}
            transition={{ duration: reduce ? 0 : .7, delay: reduce ? 0 : (count - index - 1) * .07, ease: bankEase }}
            variants={{ hover: reduce ? {} : { x: index === 0 ? -7 : index === 1 ? 2 : 5, y: index === 0 ? -9 : index === 1 ? -6 : -4, z: index === 0 ? 60 : 25, rotate: index === 0 ? -9 : index === 1 ? 2 : 9 }, pressed: reduce ? {} : { x: -7, y: -9, z: 60 } }}>
            <span className="bank-chip" />
            <span className="bank-stack-lines" />
          </motion.span>
        ))}
    </span>
  )
}

export function BankCard({
  cardId,
  active = true,
  name,
  last4,
  kind = 'debit',
  status = 'active',
  balance,
  hidden = false,
  index = 0,
}: {
  cardId?: string
  active?: boolean
  name: string
  last4?: string
  kind?: string
  status?: string
  balance?: number
  hidden?: boolean
  index?: number
}) {
  const reduce = useReducedMotion()
  return (
    <motion.article
      data-motion="physical-card"
      className={`bank-physical-card bank-lift${kind === 'credit' ? ' is-credit' : ''}`}
      tabIndex={0}
      initial={reduce ? false : { opacity: 0, y: 28, z: -100, rotateY: -14 }}
      whileInView={{ opacity: 1, y: 0, z: 0, rotateY: 0 }}
      viewport={{ once: true, amount: .2 }}
      whileHover={reduce ? undefined : { y: -4 }}
      whileTap={reduce ? undefined : { scale: .98 }}
      transition={{ duration: reduce ? 0 : .7, delay: reduce ? 0 : index * .11, ease: bankEase }}
    >
      <div className="bank-card-top">
        <strong>
          文财银行<span>WENCAI BANK</span>
        </strong>
        <Wifi size={22} />
      </div>
      <span className="bank-chip" />
      <p className="bank-card-number">
        {kind === 'account' ? (
          '人民币 · 资金账户'
        ) : (
          <CardNumber cardId={cardId} last4={last4} active={active} />
        )}
      </p>
      <div className="bank-card-bottom">
        <span>
          {name}
          <small>
            {kind === 'account'
              ? '可用余额'
              : `${kind === 'credit' ? '信用卡' : '储蓄卡'} · ${status === 'active' ? '正常' : status === 'locked' ? '已锁定' : '已挂失'}`}
          </small>
        </span>
        {balance !== undefined && <span className="bank-card-value"><small>{kind === 'credit' ? '可用额度' : '可用余额'}</small><strong>{hidden ? '••••••' : `¥ ${formatAmount(balance)}`}</strong></span>}
      </div>
    </motion.article>
  )
}
