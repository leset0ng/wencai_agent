import { normalizeAmount as normalize } from './amount'
import { derivedAmountAt } from './transactions'

/**
 * 回复文本数字校验（防幻觉）：
 * 模型回复中出现的金额、卡尾号必须能在「本轮工具结果 + 用户输入」中找到出处。
 */

const AMOUNT_RE = /(?:¥|￥)?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(?:元|块)?/g
const CARD_TAIL_RE = /尾号\s*(\d{4})/g

export interface NumberViolation {
  text: string
  kind: 'amount' | 'card_tail' | 'transaction_reference'
}

/** 把工具输出里的数字收集成可比对的集合（元为单位的字符串 + 原始数字） */
export function collectEvidence(values: unknown[]): Set<string> {
  const out = new Set<string>()
  const visit = (v: unknown, key?: string) => {
    if (typeof v === 'number') {
      out.add(normalize(v))
      out.add(normalize(Math.abs(v))) // “净支出/亏损”会用正数描述同一差额。
      // 以「分」为单位的字段同时登记为元
      if (key && /cents$/i.test(key)) out.add(normalize(v / 100))
    } else if (typeof v === 'string') {
      for (const m of v.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)) out.add(normalize(Number(m[0].replace(/,/g, ''))))
      if (/^\d{4,}$/.test(v)) out.add(v.slice(-4))
    } else if (Array.isArray(v)) {
      v.forEach((x) => visit(x))
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) visit(x, k)
    }
  }
  values.forEach((v) => visit(v))
  return out
}


export function verifyNumbers(text: string, evidence: Set<string>, sourceValues: unknown[] = []): NumberViolation[] {
  const violations: NumberViolation[] = []
  for (const m of text.matchAll(CARD_TAIL_RE)) {
    if (!evidence.has(m[1])) violations.push({ text: m[0], kind: 'card_tail' })
  }
  for (const m of text.matchAll(AMOUNT_RE)) {
    const raw = m[0]
    // 只校验明确是金额的数字（带货币符号或单位），避免误伤日期、序号
    if (!/[¥￥元块]/.test(raw)) continue
    const value = Number(`${m[1].replace(/,/g, '')}.${m[2] ?? '0'}`)
    if (!evidence.has(normalize(value)) && !derivedAmountAt(text,m.index!+raw.search(/\S/),value,sourceValues)) violations.push({ text: raw.trim(), kind: 'amount' })
  }
  return violations
}
