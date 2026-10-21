# 本地 SQLite 提交失败修复

2026-10-22。用户日志：`/api/dashboard` → `ensureUserCardAccounts` → `commit` 报 `SQLITE_BUSY: cannot commit transaction - SQL statements in progress`；同次启动较早有 worker 的 `database is locked`。

## 原因与复现

使用当前安装的 `@libsql/client 0.18.0` / `libsql 0.5.29`，两个独立本地文件连接：A 开写事务，B 的 BEGIN 因锁竞争失败；A 提交后让 B 重试 BEGIN、读取并提交。原包装器在第一轮就可复现同样的 `SQL statements in progress`，即使 A 已释放锁也不会自愈。

驱动在失败的 BEGIN/写语句后可能留下活动语句，并将该连接返回连接池。原串行队列只等待重试，复用原连接使后续 COMMIT 持续失败。该错误不是未 await 应用层查询，也不是简单增加 busy 等待时间可修复的问题。

## 修改

- `db/client.ts` 仅为持久化 `file:` 数据库开启 `reconnectOnBusy`；内存和远程库不启用，避免重连导致内存库丢失。
- 本地文件库首次请求前统一启用 WAL，初始化失败会报错而非绕过；避免回滚日志模式下残留读连接阻止另一进程 COMMIT。WAL 是持久化的日志模式，会产生 `-wal` / `-shm` 文件，备份应使用 SQLite backup 或在正常停止服务后进行。
- `serialized-client.ts` 在尚未开始的事务或单条原子语句收到 BUSY 后，通过驱动公开 reconnect 重建本进程的连接池，再在原10秒上限内重试。保留串行队列，不与其他本进程请求重叠。
- 事务内部收到 BUSY 时只标记连接，不中途重连或重放语句；在提交失败或回滚完成后才重建连接。完整纯数据库事务仍由原 db.transaction 重试；不要在事务回调中添加网络或其他外部副作用。
- 提交失败后 ORM 再次调用旧事务的 rollback，不重复恢复连接，避免误关排队中的新事务。
- 没有重置数据库、修改余额、删除流水、放宽验证或更改其他进程的连接。

## 验证

`tests/db-busy-recovery.test.ts` 用真实 SQLite 文件/两连接持锁验证 BEGIN 与原子写恢复、RETURNING 后提交、后续只读事务提交和回滚；同时验证恢复时序、旧 rollback 不干扰新事务、普通业务异常不重放，以及内存库数据保留。原 `db-concurrency.test.ts` 两进程审计测试继续验证40条流水哈希链不分叉。

最终验证：63个测试文件、740项测试全部通过；类型检查与生产构建通过。隔离库真实首页查询在外部写锁下5/5次成功，WAL读快照与另一连接写提交并行测试通过。现有业务数据库仅执行只读 `PRAGMA quick_check`，结果为 `ok`。

运行中的旧进程可能已经持有受污染连接，代码热更新不能保证替换所有旧引用；需要正常重启 web 和 worker 加载修复。不得通过删除 bank.db 处理这个错误。
