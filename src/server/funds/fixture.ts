import f110007 from '../../../fixtures/funds/110007.json'
import f000171 from '../../../fixtures/funds/000171.json'
import f110022 from '../../../fixtures/funds/110022.json'
import f161725 from '../../../fixtures/funds/161725.json'
import type { FundDataProvider, FundSnapshot } from './provider'

/** Genuine public NAV snapshots, dated as collected. Never shift dates to make an offline trade appear filled. */
const fixtures: Record<string, unknown> = { '110007': f110007, '000171': f000171, '110022': f110022, '161725': f161725 }
export class FixtureProvider implements FundDataProvider {
  async fetch(code: string, signal: AbortSignal): Promise<FundSnapshot> {
    signal.throwIfAborted()
    if (!fixtures[code]) throw new Error('FUND_SNAPSHOT_MISSING')
    return structuredClone(fixtures[code]) as FundSnapshot
  }
}
