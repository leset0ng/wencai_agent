import type { Client, Transaction } from '@libsql/client'

/**
 * 本地 SQLite 同一时刻只有一个写事务。将客户端请求排队，避免连接池在
 * JavaScript 事务 await 期间同步争锁；事务内必须使用 tx，不能使用外层 db。
 * 金额条件更新、唯一约束仍在数据库中强制校验。
 */
export function serializeLocalClient(client: Client, { reconnectOnBusy = false, wal = false }: { reconnectOnBusy?: boolean; wal?: boolean } = {}): Client {
  const isBusy = (error: unknown) => (error as { code?: string } | null)?.code === 'SQLITE_BUSY'
  // libsql can leave a failed BEGIN/write statement active after SQLITE_BUSY.
  // Retrying on that pooled connection then fails COMMIT forever. Only opt in
  // for file-backed DBs: reconnecting an in-memory database would lose its data.
  const recoverConnection = () => reconnectOnBusy ? client.reconnect() : Promise.resolve()
  async function retryBusy<T>(operation: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + 10_000
    for (let attempt = 0; ; attempt++) {
      try { return await operation() }
      catch (error) {
        if (!isBusy(error)) throw error
        await recoverConnection()
        if (Date.now() >= deadline) throw error
        // 异步等待，允许另一个进程完成短事务；仅重试尚未开始的事务/单条原子语句。
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, 10 * (attempt + 1)) + Math.random() * 10))
      }
    }
  }
  let initialized: Promise<void> | undefined
  function initialize() {
    return initialized ??= retryBusy(async () => {
      const mode = await client.execute('PRAGMA journal_mode=WAL')
      if (String(mode.rows[0]?.journal_mode).toLowerCase() !== 'wal') throw new Error('LOCAL_SQLITE_WAL_UNAVAILABLE')
    }).catch((error) => { initialized = undefined; throw error })
  }
  let tail = Promise.resolve()
  async function acquire() {
    // Persisted WAL lets the web process keep reading while the worker writes;
    // in rollback-journal mode a reader can otherwise block another COMMIT.
    if (wal) await initialize()
    const previous = tail
    let release!: () => void
    tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    return release
  }
  const operations = new Set(['execute', 'batch', 'migrate', 'executeMultiple', 'sync'])
  return new Proxy(client, {
    get(target, property) {
      if (property === 'transaction')
        return async (...args: Parameters<Client['transaction']>) => {
          const release = await acquire()
          let settled = false
          const unlock = () => {
            if (!settled) {
              settled = true
              release()
            }
          }
          let tx: Transaction
          try {
            tx = await retryBusy(() => target.transaction(...args))
          } catch (e) {
            unlock()
            throw e
          }
          let dirty = false
          return new Proxy(tx, {
            // An execute error must not reconnect while the transaction is open:
            // let its caller roll back, then discard the dirty connection.
            get(transaction, key) {
              const value = Reflect.get(transaction, key, transaction)
              if (['execute', 'batch', 'executeMultiple'].includes(String(key)))
                return async (...params: unknown[]) => {
                  try { return await Reflect.apply(value, transaction, params) }
                  catch (error) { dirty ||= isBusy(error); throw error }
                }
              if (['commit', 'rollback'].includes(String(key)))
                return async (...params: unknown[]) => {
                  try { return await Reflect.apply(value, transaction, params) }
                  catch (error) { dirty ||= isBusy(error); throw error }
                  finally {
                    if (!settled) {
                      try { if (dirty) await recoverConnection() }
                      finally { unlock() }
                    }
                  }
                }
              if (key === 'close')
                return (...params: unknown[]) => {
                  try {
                    const result = Reflect.apply(value, transaction, params)
                    if (result instanceof Promise) return result.finally(unlock)
                    unlock()
                    return result
                  } catch (e) {
                    unlock()
                    throw e
                  }
                }
              return typeof value === 'function' ? value.bind(transaction) : value
            },
          })
        }
      const value = Reflect.get(target, property, target)
      if (operations.has(String(property)))
        return async (...args: unknown[]) => {
          const release = await acquire()
          try {
            return await (property === 'execute' ? retryBusy(async () => Reflect.apply(value, target, args)) : Reflect.apply(value, target, args))
          } finally {
            release()
          }
        }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
