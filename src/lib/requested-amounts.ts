const NUMBER = /(?:[¥￥]\s*)?(\d+(?:,\d{3})*)(?:\.(\d+))?\s*(?:元|块)?/g
const moneyVerb = /(?:转账|转|打款|汇款|支付|付款|付|申购|赎回|投资|购买)\s*$/

/** Only explicit money expressions, not arbitrary phone numbers, dates or card tails. */
export function requestedAmounts(text: string): number[] {
  return [...text.matchAll(NUMBER)].flatMap((match) => {
    const before = text.slice(Math.max(0, match.index! - 16), match.index)
    if (!/[¥￥元块]/.test(match[0]) && !moneyVerb.test(before)) return []
    if ((match[2]?.length ?? 0) > 2) return []
    const amount = Number(`${match[1].replace(/,/g, '')}.${match[2] ?? '0'}`)
    return amount > 0 && amount <= 1_000_000 ? [amount] : []
  })
}

/** Bind an amount to this named recipient, so two steps cannot silently swap amounts. */
export function requestedTransferMatches(text: string, query: string, amount: number): number[] {
  if (!/(?:转|汇|付款|打款)/.test(text) || !query.trim()) return []
  const result: number[] = []
  let index = text.indexOf(query)
  while (index >= 0) {
    const after = text.slice(index + query.length)
    // Tolerate short conversational connectors/typos, but never interpret account identifiers as money.
    const next = after.match(/^([^\d，。；;\n]{0,8})(\d+(?:,\d{3})*)(?:\.(\d+))?(?![\d.])/)
    if (next && !/(?:尾号|卡号|账号|手机|电话|密码|验证码|日期)/.test(next[1]) && (next[3]?.length ?? 0) <= 2 && Number(`${next[2].replace(/,/g, '')}.${next[3] ?? '0'}`) === amount) result.push(index + query.length + next[1].length)
    // Also support “转400给妈妈”.
    const before = text.slice(0, index).match(/(?:转账|转|打款|汇款|支付|付款)\s*(\d+(?:,\d{3})*)(?:\.(\d{1,2}))?\s*(?:元|块)?\s*(?:给|到|至|向)\s*$/)
    if (before && Number(`${before[1].replace(/,/g, '')}.${before[2] ?? '0'}`) === amount) result.push(before.index! + before[0].indexOf(before[1]))
    index = text.indexOf(query, index + query.length)
  }
  return [...new Set(result)]
}

/** Recognizable “给/向…转…” clauses must not silently disappear from a prepared batch. */
export function transferClauseAmounts(text: string): { position: number; recipient: string; amount: number }[] {
  if (!/(?:转|汇|付款|打款)/.test(text)) return []
  return [...text.matchAll(/(?:给|向)\s*([^给向，。；;\n\d]{1,32}?)(?:转账|转|打款|汇款|付款|支付|付|装)?\s*(\d+(?:,\d{3})*)(?:\.(\d+))?/g)].flatMap((match) => {
    if (/尾号|卡号|账号|手机|电话|密码|验证码|日期/.test(match[1]) || (match[3]?.length ?? 0) > 2) return []
    return [{ position: match.index! + match[0].lastIndexOf(match[2]), recipient: match[1].trim(), amount: Number(`${match[2].replace(/,/g, '')}.${match[3] ?? '0'}`) }]
  })
}
