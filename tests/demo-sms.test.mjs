import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDemoSmsApp } from '../scripts/demo-sms-app.mjs'

const token = 'test-only-demo-sms-token-0123456789abcdef'
const payload = { phoneNumber: '13800000000', code: '123456', purpose: 'wencai-verification' }
const request = (app, data = payload, authorization = `Bearer ${token}`) => app.request('/send', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization }, body: JSON.stringify(data),
})
test('disabled demo mode never emits a code', async () => {
  const logs = []
  const app = createDemoSmsApp({ enabled: false, token, log: (line) => logs.push(line) })
  assert.equal((await request(app)).status, 503)
  assert.deepEqual(logs, [])
})
test('missing or incorrect credentials cannot emit a code', async () => {
  const logs = []
  const app = createDemoSmsApp({ enabled: true, token, log: (line) => logs.push(line) })
  for (const auth of ['', 'Bearer wrong', `Bearer ${'x'.repeat(token.length)}`]) assert.equal((await request(app, payload, auth)).status, 401)
  assert.deepEqual(logs, [])
})
test('malformed or oversized messages cannot inject log lines', async () => {
  const logs = []
  const app = createDemoSmsApp({ enabled: true, token, log: (line) => logs.push(line) })
  for (const data of [{ ...payload, code: '123456\nforged' }, { ...payload, phoneNumber: '13800000000\nforged' }, { ...payload, purpose: 'other' }]) {
    assert.equal((await request(app, data)).status, 400)
  }
  assert.equal((await request(app, { ...payload, extra: 'x'.repeat(3000) })).status, 413)
  assert.deepEqual(logs, [])
})
test('authorized delivery logs masked phone and never returns the code', async () => {
  const logs = []
  const app = createDemoSmsApp({ enabled: true, token, log: (line) => logs.push(line) })
  const response = await request(app)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, demo: true })
  assert.equal(logs.length, 1)
  assert.match(logs[0], /138\*\*\*\*0000: 123456/)
  assert.ok(!logs[0].includes(token))
})
