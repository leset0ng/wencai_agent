import f110007 from '../../../fixtures/funds/110007.json'
import f000171 from '../../../fixtures/funds/000171.json'
import f110022 from '../../../fixtures/funds/110022.json'
import f161725 from '../../../fixtures/funds/161725.json'
import f006989 from '../../../fixtures/funds/006989.json'
import f006804 from '../../../fixtures/funds/006804.json'
import f000015 from '../../../fixtures/funds/000015.json'
import f003376 from '../../../fixtures/funds/003376.json'
import f006961 from '../../../fixtures/funds/006961.json'
import f110027 from '../../../fixtures/funds/110027.json'
import f110020 from '../../../fixtures/funds/110020.json'
import f110026 from '../../../fixtures/funds/110026.json'
import f050025 from '../../../fixtures/funds/050025.json'
import f270042 from '../../../fixtures/funds/270042.json'
import f005827 from '../../../fixtures/funds/005827.json'
import f161005 from '../../../fixtures/funds/161005.json'
import f003095 from '../../../fixtures/funds/003095.json'
import f161726 from '../../../fixtures/funds/161726.json'
import f005939 from '../../../fixtures/funds/005939.json'
import f000216 from '../../../fixtures/funds/000216.json'
import f000001 from '../../../fixtures/funds/000001.json'
import type { FundDataProvider, FundSnapshot } from './provider'

/** Genuine public NAV snapshots, dated as collected. Never shift dates to make an offline trade appear filled. */
const fixtures: Record<string, unknown> = { '110007': f110007, '000171': f000171, '110022': f110022, '161725': f161725,
  '006989': f006989, '006804': f006804, '000015': f000015, '003376': f003376, '006961': f006961, '110027': f110027,
  '110020': f110020, '110026': f110026, '050025': f050025, '270042': f270042, '005827': f005827, '161005': f161005,
  '003095': f003095, '161726': f161726, '005939': f005939, '000216': f000216, '000001': f000001 }
export class FixtureProvider implements FundDataProvider {
  async fetch(code: string, signal: AbortSignal): Promise<FundSnapshot> {
    signal.throwIfAborted()
    if (!fixtures[code]) throw new Error('FUND_SNAPSHOT_MISSING')
    return structuredClone(fixtures[code]) as FundSnapshot
  }
}
