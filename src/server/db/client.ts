import { drizzle } from 'drizzle-orm/libsql'
import { createClient } from '@libsql/client'
import { env } from '#/server/env'
import * as auth from './auth-schema'
import * as schema from './schema'
import { serializeLocalClient } from './serialized-client'

// better-auth 的表由 drizzleAdapter 按 modelName 解析，需要全部挂在同一个 schema 对象上
const client = createClient({ url: env.DATABASE_URL })
const local = env.DATABASE_URL.startsWith('file:')
const fileBacked = local && !/:memory:|[?&]mode=memory(?:&|$)/i.test(env.DATABASE_URL)
const database = drizzle({ client: local ? serializeLocalClient(client, { reconnectOnBusy: fileBacked, wal: fileBacked }) : client, schema: { ...auth, ...schema } })
export const db = local ? new Proxy(database, {
  get(target, key) {
    if (key !== 'transaction') return Reflect.get(target, key, target)
    return async (...args: Parameters<typeof database.transaction>) => {
      const deadline = Date.now() + 10_000
      for (;;) {
        try { return await target.transaction(...args) }
        catch (error) {
          // SQLite BUSY 表示事务没有提交；驱动释放连接时回滚，再重跑纯数据库事务。
          // 事务回调禁止外部网络、日志发送等副作用。
          if ((error as { code?: string }).code !== 'SQLITE_BUSY' || Date.now() >= deadline) throw error
          await new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 50))
        }
      }
    }
  },
}) : database
export type DB = typeof db
export { schema, auth }
