/** Maintainer command: download public text only, validate, then save snapshots. No DB or remote JS execution. */
import { writeFile, rename } from 'node:fs/promises'
import { FUND_POOL } from '../src/server/funds/pool'
import { parseFundScript, parseFundStatus } from '../src/server/funds/eastmoney'
import { validateSnapshot } from '../src/server/funds/provider'

let lastRequest = 0
async function text(url: string) {
  await new Promise((r) => setTimeout(r, Math.max(0, lastRequest + 1000 - Date.now())))
  lastRequest = Date.now()
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'error', headers: { Referer: 'https://fund.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' } })
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP_${response.status}`) }
  const reader = response.body!.getReader(), chunks: Uint8Array[] = []; let total = 0
  try { for (;;) { const r = await reader.read(); if (r.done) break; total += r.value.length; if (total > 2 * 1024 * 1024) throw new Error('RESPONSE_TOO_LARGE'); chunks.push(r.value) } }
  finally { await reader.cancel() }
  const bytes = new Uint8Array(total); let offset = 0
  for (const c of chunks) { bytes.set(c, offset); offset += c.length }
  return new TextDecoder(/gb/i.test(response.headers.get('content-type') ?? '') ? 'gb18030' : 'utf-8').decode(bytes)
}
const codes = process.argv.slice(2)
if (codes.some((code) => !FUND_POOL.some((f) => f.code === code))) throw new Error('FUND_NOT_ALLOWED')
for (const fund of FUND_POOL.filter((f) => !codes.length || codes.includes(f.code))) {
  try {
  const script = await text(`https://fund.eastmoney.com/pingzhongdata/${fund.code}.js`)
  const parsed = parseFundScript(script)
  const page = await text(`https://fund.eastmoney.com/${fund.code}.html`)
  const basic = await text(`https://fundf10.eastmoney.com/jbgk_${fund.code}.html`)
  if (!page.includes(parsed.name)) throw new Error('FUND_NAME_MISMATCH')
  const institution = basic.match(/基金管理人<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/)?.[1].replace(/<[^>]+>/g, '').trim()
  const inceptionDate = basic.match(/成立日期[：:]<span>(\d{4}-\d{2}-\d{2})<\/span>/)?.[1]
  const size = script.match(/\bvar\s+Data_fluctuationScale\s*=\s*(\{[^;]+\})\s*;/)
  const scale = size ? JSON.parse(size[1]) : undefined
  if (!institution || !inceptionDate) throw new Error(`FUND_METADATA_MISSING:${fund.code}`)
  const data = validateSnapshot({ code: fund.code, ...parsed, ...parseFundStatus(page), source: 'fixture', fetchedAt: new Date().toISOString(),
    metadata: { institution, inceptionDate, ...(scale?.series?.length ? { scaleYiYuan: scale.series.at(-1).y, scaleDate: scale.categories.at(-1) } : {}), endpoint: 'eastmoney_pingzhongdata' } }, fund.code)
  const file = new URL(`../fixtures/funds/${fund.code}.json`, import.meta.url), temp = new URL(file.href + '.tmp')
  await writeFile(temp, JSON.stringify(data) + '\n'); await rename(temp, file)
  console.log(JSON.stringify({ code: fund.code, name: data.name, observations: data.navs.length, last: data.navs.at(-1)?.date, status: data.purchaseStatus }))
  } catch (error) { console.error(JSON.stringify({ code: fund.code, error: String(error) })); process.exitCode = 1 }
}
