import type { FundDataProvider, FundSnapshot } from './provider'
import { cstDate } from './provider'
import { FixtureProvider } from './fixture'

const LIMIT = 2 * 1024 * 1024
/** Treat remote JS as inert text. These are the only assignments we accept; JSON.parse never evaluates JS. */
export function parseFundScript(text: string) {
  const string = (key: string) => {
    const match = text.match(new RegExp('\\bvar\\s+' + key + '\\s*=\\s*(["\'])([^"\'\\r\\n]*)\\1\\s*;'))
    if (!match) throw new Error('FUND_METADATA_INVALID:' + key)
    return match[2]
  }
  const array = (key: string) => {
    const match = text.match(new RegExp('\\bvar\\s+' + key + '\\s*=\\s*(\\[[^;]+\\])\\s*;'))
    if (!match) throw new Error('FUND_HISTORY_INVALID')
    return JSON.parse(match[1]) as unknown
  }
  const unit = array('Data_netWorthTrend'), acc = array('Data_ACWorthTrend')
  if (!Array.isArray(unit) || !Array.isArray(acc)) throw new Error('FUND_HISTORY_INVALID')
  const totals = new Map(acc.map((r: unknown) => {
    if (!Array.isArray(r) || typeof r[0] !== 'number' || typeof r[1] !== 'number') throw new Error('FUND_HISTORY_INVALID')
    return [cstDate(new Date(r[0])), r[1]] as const
  }))
  const navs = unit.map((r: unknown) => {
    if (!r || typeof r !== 'object' || !('x' in r) || !('y' in r) || typeof r.x !== 'number' || typeof r.y !== 'number') throw new Error('FUND_HISTORY_INVALID')
    const date = cstDate(new Date(r.x))
    return { date, unitNav: r.y, accNav: totals.get(date)!, ...('equityReturn' in r && typeof r.equityReturn === 'number' ? { dailyReturnPct: r.equityReturn } : {}) }
  })
  return { name: string('fS_name'), purchaseFeeRate: Number(string('fund_Rate')) / 100, minPurchaseCents: Number(string('fund_minsg')) * 100, navs }
}
let requestTail: Promise<unknown> = Promise.resolve(), lastRequest = 0
export function parseFundStatus(html: string) {
  // Require the label's colon: the site's navigation also contains an unrelated “申购状态” link.
  const status = html.match(/(?:交易状态|申购状态|购买状态)\s*[：:][\s\S]{0,600}/)?.[0] ?? ''
  const purchase = status.match(/开放申购|限制大额申购|限大额|暂停申购|封闭期/)?.[0]
  const redeem = status.match(/开放赎回|暂停赎回|封闭期/)?.[0]
  if (!purchase || !redeem) throw new Error('FUND_STATUS_UNAVAILABLE')
  return { purchaseStatus: purchase === '开放申购' ? 'open' as const : /限/.test(purchase) ? 'limited' as const : 'suspended' as const,
    redeemStatus: redeem === '开放赎回' ? 'open' as const : 'suspended' as const }
}
async function limitedText(url: string, signal: AbortSignal, fetcher: typeof fetch) {
  // Global one request/second; rate wait does not hold any database transaction.
  const turn = requestTail.catch(() => {}).then(async () => {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, lastRequest + 1000 - Date.now())))
    signal.throwIfAborted(); lastRequest = Date.now()
  })
  requestTail = turn; await turn
  const response = await fetcher(url, { signal, redirect: 'error', headers: { Referer: 'https://fund.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' } })
  if (Number(response.headers.get('content-length') ?? 0) > LIMIT) { await response.body?.cancel(); throw new Error('FUND_RESPONSE_TOO_LARGE') }
  if (!response.ok) { await response.body?.cancel(); throw new Error('FUND_HTTP_ERROR') }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('FUND_EMPTY_RESPONSE')
  const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break
      size += value.length; if (size > LIMIT) throw new Error('FUND_RESPONSE_TOO_LARGE')
      chunks.push(value)
    }
  } finally { await reader.cancel() }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return new TextDecoder(/gb/i.test(response.headers.get('content-type') ?? '') ? 'gb18030' : 'utf-8').decode(bytes)
}
export class EastmoneyProvider implements FundDataProvider {
  constructor(private fetcher: typeof fetch = fetch) {}
  async fetch(code: string, signal: AbortSignal): Promise<FundSnapshot> {
    if (!/^\d{6}$/.test(code)) throw new Error('FUND_CODE_INVALID')
    const combined = AbortSignal.any([signal, AbortSignal.timeout(12000)])
    let metadata: ReturnType<typeof parseFundScript>
    let source: FundSnapshot['source'] = 'eastmoney'
    try { metadata = parseFundScript(await limitedText(`https://fund.eastmoney.com/pingzhongdata/${code}.js`, combined, this.fetcher)) }
    catch (error) {
      if (combined.aborted || (error instanceof Error && /TOO_LARGE/.test(error.message))) throw error
      const cached = await new FixtureProvider().fetch(code, combined)
      const json = JSON.parse(await limitedText(`https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=20`, combined, this.fetcher))
      const rows = json?.Data?.LSJZList
      if (!Array.isArray(rows) || !rows.length || rows.length > 100) throw new Error('FUND_HISTORY_UNAVAILABLE')
      const navs = new Map(cached.navs.map((n) => [n.date, n]))
      for (const r of rows) {
        if (typeof r.FSRQ !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(r.DWJZ ?? '') || !/^-?\d+(?:\.\d+)?$/.test(r.LJJZ ?? '')) throw new Error('FUND_HISTORY_INVALID')
        navs.set(r.FSRQ, { date: r.FSRQ, unitNav: Number(r.DWJZ), accNav: Number(r.LJJZ), ...(/^-?\d+(?:\.\d+)?$/.test(r.JZZZL ?? '') ? { dailyReturnPct: Number(r.JZZZL) } : {}) })
      }
      // Old cached fee metadata cannot authorize fresh purchases when its live source is down.
      metadata = { name: cached.name, purchaseFeeRate: cached.purchaseFeeRate, minPurchaseCents: cached.minPurchaseCents, navs: [...navs.values()].sort((a, b) => a.date.localeCompare(b.date)) }
      source = 'eastmoney_json'
    }
    // The JSON history API sometimes returns Data:null. Status must still be verified, never assumed open.
    const html = await limitedText(`https://fund.eastmoney.com/${code}.html`, combined, this.fetcher)
    if (!html.includes(metadata.name)) throw new Error('FUND_NAME_MISMATCH')
    const fallbackMeta = (await new FixtureProvider().fetch(code, combined)).metadata ?? {}
    return { code, ...metadata, ...parseFundStatus(html), ...(source === 'eastmoney_json' ? { purchaseStatus: 'suspended' as const } : {}),
      metadata: { ...fallbackMeta, endpoint: source === 'eastmoney_json' ? 'eastmoney_f10_lsjz+snapshot' : 'eastmoney_pingzhongdata' }, source, fetchedAt: new Date().toISOString() }
  }
}
