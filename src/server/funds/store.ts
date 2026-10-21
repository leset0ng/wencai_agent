import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, lte, sql } from 'drizzle-orm'
import { db, schema } from '#/server/db/client'
import { FUND_POOL, allowedFund } from './pool'
import { cstDate, staleNav, validateSnapshot, type FundDataProvider, type FundSnapshot } from './provider'
import { EastmoneyProvider } from './eastmoney'
import { FixtureProvider } from './fixture'

let ready: Promise<void> | undefined
export function ensureFundSchema() {
  return ready ??= (async () => {
    const statements = [
      'CREATE TABLE IF NOT EXISTS bank_funds (code TEXT PRIMARY KEY,name TEXT NOT NULL,category TEXT NOT NULL,risk_rating TEXT NOT NULL,purchase_status TEXT NOT NULL,redeem_status TEXT NOT NULL,purchase_fee_bp INTEGER NOT NULL,min_purchase_cents INTEGER NOT NULL,enabled INTEGER NOT NULL,source TEXT NOT NULL,updated_at TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS bank_fund_navs (code TEXT NOT NULL,nav_date TEXT NOT NULL,unit_nav_e4 INTEGER NOT NULL,acc_nav_e4 INTEGER NOT NULL,fetched_at TEXT NOT NULL,PRIMARY KEY(code,nav_date))',
      'CREATE TABLE IF NOT EXISTS bank_fund_sync_state (code TEXT PRIMARY KEY,lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,next_run_at INTEGER NOT NULL DEFAULT 0,last_success_at TEXT,last_error_code TEXT)',
      'CREATE TABLE IF NOT EXISTS bank_fund_orders (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,action_id TEXT NOT NULL UNIQUE,code TEXT NOT NULL,side TEXT NOT NULL,amount_cents INTEGER NOT NULL,shares_e2 INTEGER,account_id TEXT NOT NULL,trade_date TEXT NOT NULL,status TEXT NOT NULL,nav_date TEXT,unit_nav_e4 INTEGER,fee_cents INTEGER,transaction_id TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,confirmed_at TEXT)',
      'CREATE INDEX IF NOT EXISTS bank_fund_orders_due ON bank_fund_orders(status,trade_date)',
      'CREATE TABLE IF NOT EXISTS bank_fund_positions (user_id TEXT NOT NULL,code TEXT NOT NULL,shares_e2 INTEGER NOT NULL,cost_cents INTEGER NOT NULL,PRIMARY KEY(user_id,code))',
    ]
    for (const statement of statements) await db.$client.execute(statement)
    for (const [table, column, definition] of [
      ['bank_funds', 'metadata_json', "TEXT NOT NULL DEFAULT '{}'"], ['bank_fund_navs', 'daily_return_e8', 'INTEGER'],
    ]) {
      const info = await db.$client.execute(`PRAGMA table_info(${table})`)
      if (!info.rows.some((r) => r.name === column)) {
        try { await db.$client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`) }
        catch (e) { if (!/duplicate column/i.test(String(e))) throw e }
      }
    }
    await db.$client.execute('CREATE TABLE IF NOT EXISTS bank_fund_watchlist (user_id TEXT NOT NULL,code TEXT NOT NULL,PRIMARY KEY(user_id,code))')
  })().catch((e) => { ready = undefined; throw e })
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
async function saveSnapshot(tx: Tx, data: FundSnapshot) {
  const fund = allowedFund(data.code)
  // A name-mismatch quarantine is never silently lifted by a later response.
  await tx.insert(schema.bankFunds).values({ ...fund, purchaseStatus: data.purchaseStatus, redeemStatus: data.redeemStatus,
    purchaseFeeBp: Math.round(data.purchaseFeeRate * 10000), minPurchaseCents: data.minPurchaseCents, enabled: true, source: data.source, updatedAt: data.fetchedAt, metadataJson: JSON.stringify(data.metadata ?? {}),
  }).onConflictDoUpdate({ target: schema.bankFunds.code, set: {
    purchaseStatus: data.purchaseStatus, redeemStatus: data.redeemStatus, purchaseFeeBp: Math.round(data.purchaseFeeRate * 10000),
    minPurchaseCents: data.minPurchaseCents, source: data.source, updatedAt: data.fetchedAt, metadataJson: JSON.stringify(data.metadata ?? {}),
  } })
  // Chunk below SQLite variable limits. All records were validated before entering this transaction.
  for (let offset = 0; offset < data.navs.length; offset += 80) {
    await tx.insert(schema.bankFundNavs).values(data.navs.slice(offset, offset + 80).map((n) => ({ code: data.code,
      navDate: n.date, unitNavE4: Math.round(n.unitNav * 10000), accNavE4: Math.round(n.accNav * 10000), fetchedAt: data.fetchedAt,
      dailyReturnE8: n.dailyReturnPct === undefined ? null : Math.round(n.dailyReturnPct * 1e6),
    }))).onConflictDoUpdate({ target: [schema.bankFundNavs.code, schema.bankFundNavs.navDate], set: {
      unitNavE4: sql`excluded.unit_nav_e4`, accNavE4: sql`excluded.acc_nav_e4`, fetchedAt: sql`excluded.fetched_at`,
      dailyReturnE8: sql`COALESCE(excluded.daily_return_e8, bank_fund_navs.daily_return_e8)`,
    } })
  }
}
/** Used by both the worker and offline bootstrap. Fetch/validation always precede the DB transaction. */
export async function syncFund(code: string, provider: FundDataProvider, now = new Date(), force = false) {
  allowedFund(code); await ensureFundSchema()
  const token = randomUUID(), wall = Date.now()
  await db.insert(schema.bankFundSyncState).values({ code }).onConflictDoNothing()
  const lease = await db.update(schema.bankFundSyncState).set({ leaseToken: token, leaseUntil: wall + 30_000 })
    .where(and(eq(schema.bankFundSyncState.code, code), lte(schema.bankFundSyncState.leaseUntil, wall), ...(force ? [] : [lte(schema.bankFundSyncState.nextRunAt, wall)]))).returning()
  if (!lease.length) return { code, status: 'busy_or_not_due' }
  try {
    const data = validateSnapshot(await provider.fetch(code, AbortSignal.timeout(15000)), code, now)
    await db.transaction(async (tx) => {
      const [owner] = await tx.select().from(schema.bankFundSyncState).where(and(eq(schema.bankFundSyncState.code, code), eq(schema.bankFundSyncState.leaseToken, token)))
      if (!owner || owner.leaseUntil < Date.now()) throw new Error('FUND_LEASE_LOST')
      await saveSnapshot(tx, data)
      await tx.update(schema.bankFundSyncState).set({ leaseToken: null, leaseUntil: 0, nextRunAt: wall + 30 * 60_000, lastSuccessAt: data.fetchedAt, lastErrorCode: null }).where(eq(schema.bankFundSyncState.code, code))
    })
    return { code, status: 'updated', source: data.source }
  } catch (error) {
    const nameMismatch = error instanceof Error && error.message === 'FUND_NAME_MISMATCH'
    await db.transaction(async (tx) => {
      const released = await tx.update(schema.bankFundSyncState).set({ leaseToken: null, leaseUntil: 0, nextRunAt: wall + 30 * 60_000,
        lastErrorCode: nameMismatch ? 'FUND_NAME_MISMATCH' : 'FUND_SYNC_FAILED',
      }).where(and(eq(schema.bankFundSyncState.code, code), eq(schema.bankFundSyncState.leaseToken, token))).returning()
      if (nameMismatch && released.length) await tx.update(schema.bankFunds).set({ enabled: false }).where(eq(schema.bankFunds.code, code))
    })
    return { code, status: 'cached', error: nameMismatch ? 'FUND_NAME_MISMATCH' : 'FUND_SYNC_FAILED' }
  }
}
let bootstrap: Promise<void> | undefined
export function ensureFundData() {
  return bootstrap ??= (async () => {
    await ensureFundSchema()
    for (const fund of FUND_POOL) {
      const [existing] = await db.select().from(schema.bankFunds).where(eq(schema.bankFunds.code, fund.code))
      if (!existing) {
        await syncFund(fund.code, new FixtureProvider(), new Date(), true)
        await db.update(schema.bankFundSyncState).set({ nextRunAt: 0 }).where(and(eq(schema.bankFundSyncState.code, fund.code), eq(schema.bankFundSyncState.leaseUntil, 0)))
      } else {
        const fixture = validateSnapshot(await new FixtureProvider().fetch(fund.code, AbortSignal.timeout(1000)), fund.code)
        // Add missing historical records without reverting current prices, sales status, source or fees.
        await db.transaction(async (tx) => {
          for (let offset = 0; offset < fixture.navs.length; offset += 80) await tx.insert(schema.bankFundNavs).values(fixture.navs.slice(offset, offset + 80).map((n) => ({ code: fund.code,
            navDate: n.date, unitNavE4: Math.round(n.unitNav * 10000), accNavE4: Math.round(n.accNav * 10000), fetchedAt: fixture.fetchedAt,
            dailyReturnE8: n.dailyReturnPct === undefined ? null : Math.round(n.dailyReturnPct * 1e6),
          }))).onConflictDoUpdate({ target: [schema.bankFundNavs.code, schema.bankFundNavs.navDate], set: { dailyReturnE8: sql`COALESCE(bank_fund_navs.daily_return_e8, excluded.daily_return_e8)` } })
          if (existing.metadataJson === '{}') await tx.update(schema.bankFunds).set({ metadataJson: JSON.stringify(fixture.metadata ?? {}) }).where(eq(schema.bankFunds.code, fund.code))
        })
      }
    }
  })().catch((e) => { bootstrap = undefined; throw e })
}
export async function listFunds(now = new Date()) {
  await ensureFundData()
  const rows = await db.select().from(schema.bankFunds), sync = await db.select().from(schema.bankFundSyncState)
  return Promise.all(rows.map(async (fund) => {
    const [nav] = await db.select().from(schema.bankFundNavs).where(and(eq(schema.bankFundNavs.code, fund.code), lte(schema.bankFundNavs.navDate, cstDate(now)))).orderBy(desc(schema.bankFundNavs.navDate)).limit(1)
    return { ...fund, navDate: nav?.navDate ?? null, unitNav: nav ? nav.unitNavE4 / 10000 : null,
      stale: !nav || staleNav(nav.navDate, now), cached: true, syncError: sync.find((s) => s.code === fund.code)?.lastErrorCode ?? null,
      riskLabel: '人工维护的演示适当性等级', realTrading: false }
  }))
}
export async function fundDetails(code: string, now = new Date()) {
  allowedFund(code)
  const fund = (await listFunds(now)).find((f) => f.code === code)
  if (!fund) throw new Error('FUND_DATA_UNAVAILABLE')
  const navs = await db.select().from(schema.bankFundNavs).where(and(eq(schema.bankFundNavs.code, code), lte(schema.bankFundNavs.navDate, cstDate(now)))).orderBy(asc(schema.bankFundNavs.navDate))
  return { ...fund, navs }
}
export async function refreshFunds(now = new Date(), provider?: FundDataProvider) {
  await ensureFundData()
  const mode = process.env.FUND_DATA_MODE ?? 'live'
  if (mode === 'cache') return []
  if (!['live', 'fixture'].includes(mode)) throw new Error('FUND_DATA_MODE_INVALID')
  const result = []
  for (const fund of FUND_POOL) result.push(await syncFund(fund.code, provider ?? (mode === 'fixture' ? new FixtureProvider() : new EastmoneyProvider()), now))
  return result
}
