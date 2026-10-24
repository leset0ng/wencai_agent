import { describe, expect, it } from 'vitest'
import {
  BEIJING_OFFSET_MS,
  DAY_MS,
  beijingDate,
  beijingDateTime,
  beijingDayRange,
  beijingDayStart,
  beijingMonth,
} from '#/lib/time'
import { centsToYuan, formatCents, formatYuan, yuanToCents } from '#/lib/money'
import { businessDate, businessDateTime, businessMonth, formatAmount } from '#/lib/dashboard'

/**
 * 共享工具必须与项目中既有的手写实现结果一致，迁移时才不会改变行为。
 * 下面的 legacy* 是从现有代码中原样摘出的写法。
 */
const legacyDayStart = (now: Date) => {
  // policy/transfer-activity.ts、cards/service.ts、life/service.ts 中的写法
  const day = 86_400_000
  return new Date(Math.floor((now.getTime() + 8 * 3600_000) / day) * day - 8 * 3600_000)
}
const legacyCstDate = (now: Date) => new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10) // funds/provider.ts
const legacyYuan = (cents: number) => Math.round(cents) / 100 // tools/bank.ts、tools/bank-extended.ts
const legacyFmt = (cents: number) =>
  new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(cents / 100) // bank-extended.ts
const legacyAdminMoney = (cents: number) =>
  new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2 }).format(cents / 100) // admin/utils.ts
const legacyPlain = (cents: number) =>
  (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) // PaymentCenter.tsx
const legacyTemplate = (cents: number) =>
  `¥${(cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` // mandates.ts、FundPanel.tsx

// 覆盖北京时间日界前后、UTC 日界前后、跨月、跨年与闰日
const MOMENTS = [
  '2026-10-23T15:59:59.999Z', // 北京 23:59:59.999
  '2026-10-23T16:00:00.000Z', // 北京次日 00:00
  '2026-10-23T23:59:59.999Z',
  '2026-10-24T00:00:00.000Z',
  '2026-10-31T16:30:00.000Z', // 北京 11-01
  '2026-12-31T16:00:00.000Z', // 北京 2027-01-01
  '2028-02-28T16:00:00.000Z', // 北京 2028-02-29
  '1970-01-01T00:00:00.000Z',
].map((iso) => new Date(iso))

describe('lib/time 与既有写法一致', () => {
  it.each(MOMENTS)('%s', (moment) => {
    expect(beijingDayStart(moment).getTime()).toBe(legacyDayStart(moment).getTime())
    expect(beijingDate(moment)).toBe(legacyCstDate(moment))
    // 原 lib/dashboard 的三个函数现已转发到 lib/time，名称不变
    expect(businessDate(moment)).toBe(beijingDate(moment))
    expect(businessMonth(moment)).toBe(new Date(moment.getTime() + 8 * 3600_000).toISOString().slice(0, 7))
    expect(businessDateTime(moment)).toBe(
      new Date(moment.getTime() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' '),
    )
    expect(beijingMonth(moment)).toBe(businessMonth(moment))
    expect(beijingDateTime(moment)).toBe(businessDateTime(moment))
  })

  it('日界：北京时间 23:59:59.999 与次日 00:00 分属两天', () => {
    expect(beijingDate(new Date('2026-10-23T15:59:59.999Z'))).toBe('2026-10-23')
    expect(beijingDate(new Date('2026-10-23T16:00:00.000Z'))).toBe('2026-10-24')
    expect(beijingDayStart(new Date('2026-10-24T03:00:00.000Z')).toISOString()).toBe('2026-10-23T16:00:00.000Z')
  })

  it('日范围为左闭右开的 24 小时', () => {
    const { start, end } = beijingDayRange(new Date('2026-10-24T03:00:00.000Z'))
    expect(end.getTime() - start.getTime()).toBe(DAY_MS)
    expect(start.toISOString()).toBe('2026-10-23T16:00:00.000Z')
    expect(BEIJING_OFFSET_MS).toBe(8 * 3600_000)
  })
})

const CENTS = [0, 1, 99, 100, 123456, 100_000_000, -1, -123456, 1234.5, 1234.4]

describe('lib/money 与既有写法一致', () => {
  it.each(CENTS)('%s 分', (cents) => {
    expect(centsToYuan(cents)).toBe(legacyYuan(cents))
    expect(formatYuan(cents)).toBe(legacyAdminMoney(cents))
    expect(formatCents(cents)).toBe(legacyPlain(cents))
    expect(formatCents(cents)).toBe(formatAmount(cents / 100))
  })

  it('整分金额与 Intl 货币格式一致', () => {
    for (const cents of [0, 1, 99, 100, 123456, -123456]) expect(formatYuan(cents)).toBe(legacyFmt(cents))
  })

  it('正数与模板写法 `¥${...}` 一致；负数统一为 -¥（模板写法会产生 ¥-）', () => {
    for (const cents of [0, 1, 123456, 100_000_000]) expect(formatYuan(cents)).toBe(legacyTemplate(cents))
    expect(formatYuan(-123456)).toBe('-¥1,234.56')
    expect(legacyTemplate(-123456)).toBe('¥-1,234.56')
  })

  it('元 → 分处理浮点误差', () => {
    expect(yuanToCents(0.29)).toBe(29)
    expect(yuanToCents(1.005)).toBe(100) // 1.005 在二进制中略小于 1.005，与 Math.round(x*100) 的既有行为一致
    expect(yuanToCents(19.99)).toBe(1999)
    expect(yuanToCents(3000.01)).toBe(300001)
    expect(yuanToCents(-12.34)).toBe(-1234)
  })

  it('常见展示样例', () => {
    expect(formatYuan(123456)).toBe('¥1,234.56')
    expect(formatCents(100_000_000)).toBe('1,000,000.00')
    expect(centsToYuan(150_000)).toBe(1500)
  })
})
