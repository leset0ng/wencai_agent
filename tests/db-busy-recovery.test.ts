import { randomUUID } from 'node:crypto'
import { mkdir, unlink } from 'node:fs/promises'
import { createClient, type Client, type Transaction } from '@libsql/client'
import { describe, expect, it, vi } from 'vitest'
import { serializeLocalClient } from '#/server/db/serialized-client'

describe('本地 SQLite 锁错误后的连接恢复', () => {
  it('持有读快照时，另一连接仍能提交且读快照不出现半写数据', async () => {
    await mkdir('.scratch', { recursive: true })
    const file = `.scratch/busy-wal-${randomUUID()}.db`, url = `file:./${file}`
    const client = serializeLocalClient(createClient({ url, timeout: 0 }), { reconnectOnBusy: true, wal: true })
    const reader = createClient({ url, timeout: 0 })
    try {
      await client.execute('CREATE TABLE balances (id INTEGER PRIMARY KEY, value INTEGER)')
      await client.execute('INSERT INTO balances VALUES(1,10)')
      const snapshot = await reader.transaction('read')
      try {
        expect((await snapshot.execute('SELECT value FROM balances')).rows[0].value).toBe(10)
        const update = await client.transaction()
        await update.execute('UPDATE balances SET value=20')
        await update.commit()
        expect((await snapshot.execute('SELECT value FROM balances')).rows[0].value).toBe(10)
      } finally { await snapshot.rollback() }
      expect((await reader.execute('SELECT value FROM balances')).rows[0].value).toBe(20)
    } finally {
      reader.close(); client.close()
      await unlink(file).catch(() => {})
    }
  })

  it('外部连接短暂持锁后，BEGIN重试与原子写重试不会污染后续提交', async () => {
    await mkdir('.scratch', { recursive: true })
    const file = `.scratch/busy-recovery-${randomUUID()}.db`, url = `file:./${file}`
    const writer = createClient({ url, timeout: 0 })
    const client = serializeLocalClient(createClient({ url, timeout: 0 }), { reconnectOnBusy: true })
    try {
      await writer.execute('CREATE TABLE counters (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)')
      await writer.execute('INSERT INTO counters VALUES(1,0)')
      for (const mode of ['begin', 'atomic'] as const) {
        const hold = await writer.transaction()
        await hold.execute('UPDATE counters SET value=value+1')
        const pending = mode === 'begin' ? client.transaction() : client.execute('UPDATE counters SET value=value+1')
        // Let the first attempt encounter the actual SQLite writer lock.
        await new Promise((r) => setTimeout(r, 35))
        await hold.commit()
        const result = await pending
        if (mode === 'begin') {
          const tx = result as Transaction
          await tx.execute('UPDATE counters SET value=value+1 RETURNING value')
          await tx.commit()
        }
        const check = await client.transaction()
        await check.execute('SELECT value FROM counters')
        await check.commit()
      }
      expect((await client.execute('SELECT value FROM counters')).rows[0].value).toBe(4)
      const rollback = await client.transaction()
      await rollback.execute('UPDATE counters SET value=999')
      await rollback.rollback()
      expect((await client.execute('SELECT value FROM counters')).rows[0].value).toBe(4)
    } finally {
      writer.close(); client.close()
      await unlink(file).catch(() => {})
    }
  })

  it('事务内失败先回滚再恢复；过期的再次rollback不关闭新事务', async () => {
    const busy = Object.assign(new Error('SQL statements in progress'), { code: 'SQLITE_BUSY' })
    const reconnect = vi.fn(async () => {}), commit = vi.fn(async () => {}), rollback = vi.fn(async () => {})
    const tx = { execute: vi.fn().mockRejectedValueOnce(busy).mockResolvedValue({ rows: [] }), commit, rollback }
    const raw = { transaction: vi.fn(async () => tx), reconnect } as unknown as Client
    const client = serializeLocalClient(raw, { reconnectOnBusy: true })
    const failed = await client.transaction()
    await expect(failed.execute('UPDATE x')).rejects.toBe(busy)
    expect(reconnect).not.toHaveBeenCalled()
    await failed.rollback()
    expect(reconnect).toHaveBeenCalledTimes(1)
    const next = await client.transaction()
    await failed.rollback()
    expect(reconnect).toHaveBeenCalledTimes(1)
    await next.commit()
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('普通业务错误不重连、不重放；未开启恢复的内存库不重连', async () => {
    const failure = new Error('constraint'), reconnect = vi.fn(async () => {})
    const execute = vi.fn(async () => { throw failure })
    const client = serializeLocalClient({ execute, reconnect } as unknown as Client, { reconnectOnBusy: true })
    await expect(client.execute('INSERT')).rejects.toBe(failure)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(reconnect).not.toHaveBeenCalled()
    const memory = serializeLocalClient(createClient({ url: ':memory:' }))
    try {
      await memory.execute('CREATE TABLE kept (value INTEGER)')
      await memory.execute('INSERT INTO kept VALUES(42)')
      const tx = await memory.transaction()
      await tx.execute('UPDATE kept SET value=43')
      await tx.rollback()
      expect((await memory.execute('SELECT value FROM kept')).rows[0].value).toBe(42)
    } finally { memory.close() }
  })
})
