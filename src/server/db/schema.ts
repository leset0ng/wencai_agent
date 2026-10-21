import { integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
export { bankCardNumbers } from './card-schema'
export { bankInitialEnrollments } from './enrollment-schema'
export { bankCardPasswords, bankSecureRequests } from './security-operation-schema'
export { bankLifeOrders, bankLifeSubscriptions } from './life-schema'
export * from './fund-schema'

// 金额统一以「分」为单位存储，避免浮点误差

/**
 * 渠道身份绑定。一行 = 一个外部账号被授权代表某个银行用户操作。
 * 飞书 open_id、MCP OAuth client 等都走这张表；未绑定的渠道账号查不到任何数据。
 */
export const channelBindings = sqliteTable('channel_bindings', {
  id: text('id').primaryKey(),
  channel: text('channel', { enum: ['lark', 'mcp'] }).notNull(),
  /** 渠道内的用户标识，如飞书 open_id */
  externalId: text('external_id').notNull(),
  userId: text('user_id').notNull(),
  boundAt: integer('bound_at', { mode: 'timestamp_ms' }).notNull(),
  boundBySessionId: text('bound_by_session_id').notNull(),
  revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
})

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  // 账户级锁定（强验证连续失败、异常交易触发熔断）
  lockedUntil: integer('locked_until', { mode: 'timestamp_ms' }),
  failedAuthCount: integer('failed_auth_count').notNull().default(0),
  // 风险测评结果，有效期 365 天；未测评视为 R1
  riskRating: text('risk_rating', { enum: ['R1', 'R2', 'R3', 'R4', 'R5'] }).notNull().default('R1'),
  riskAssessedAt: text('risk_assessed_at'),
})

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  balanceCents: integer('balance_cents').notNull(),
  currency: text('currency').notNull().default('CNY'),
})

export const bankExecutionLocks = sqliteTable('bank_execution_locks', {
  userId: text('user_id').primaryKey(),
  token: text('token').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
})

export const bankStepUpCodes = sqliteTable('bank_step_up_codes', {
  id: text('id').primaryKey(), userId: text('user_id').notNull(), scope: text('scope').notNull(),
  codeHash: text('code_hash').notNull(), attempts: integer('attempts').notNull().default(0),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
})

export const bankNotifications = sqliteTable('bank_notifications', {
  id: text('id').primaryKey(), userId: text('user_id').notNull(), type: text('type').notNull(),
  title: text('title').notNull(), body: text('body').notNull(), actionId: text('action_id'),
  dedupeKey: text('dedupe_key').notNull().unique(), createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  readAt: integer('read_at', { mode: 'timestamp_ms' }),
})
export const bankTaskPermissions = sqliteTable('bank_task_permissions', {
  taskId: text('task_id').primaryKey(), level: text('level', { enum: ['yellow', 'red'] }).notNull(),
  payeeRiskJson: text('payee_risk_json'),
})
export const bankTaskApprovals = sqliteTable('bank_task_approvals', {
  taskId: text('task_id').primaryKey(), actionId: text('action_id').notNull().unique(),
})

export const bankSplitRequests = sqliteTable('bank_split_requests', {
  id: text('id').primaryKey(), splitId: text('split_id').notNull(), contactId: text('contact_id').notNull(),
  requesterUserId: text('requester_user_id').notNull(), payerUserId: text('payer_user_id').notNull(),
  targetAccountId: text('target_account_id').notNull(), amountCents: integer('amount_cents').notNull(),
  status: text('status').notNull(), transactionId: text('transaction_id'),
}, (t) => [uniqueIndex('bank_split_participant').on(t.splitId, t.contactId)])

export const bankBirthdayFunds = sqliteTable('bank_birthday_funds', {
  planId: text('plan_id').primaryKey(), userId: text('user_id').notNull(), accountId: text('account_id').notNull(),
  heldCents: integer('held_cents').notNull(), status: text('status').notNull(),
})

export const payees = sqliteTable('payees', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  alias: text('alias'), // 如「妈妈」「房东」
  accountNo: text('account_no').notNull(),
  bank: text('bank').notNull(),
  phone: text('phone'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

export const transactions = sqliteTable('transactions', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  amountCents: integer('amount_cents').notNull(), // 负数为支出
  counterparty: text('counterparty').notNull(), // 外部可控文本
  memo: text('memo'), // 外部可控文本：间接注入的主要来源
  category: text('category').notNull(),
  occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull(),
  // 冲正关联：补偿动作生成的流水指向原流水
  reversalOf: text('reversal_of'),
})

// 独立扩展表让已有演示数据库可无损升级。
export const bankAccountAddresses = sqliteTable('bank_account_addresses', {
  accountId: text('account_id').primaryKey().references(() => accounts.id, { onDelete: 'cascade' }),
  accountNo: text('account_no').notNull().unique(),
})

export const bankPayeeLinks = sqliteTable('bank_payee_links', {
  payeeId: text('payee_id').primaryKey().references(() => payees.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  targetAccountId: text('target_account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
}, (t) => [uniqueIndex('bank_payee_owner_target').on(t.userId, t.targetAccountId)])

export const bankTransferLinks = sqliteTable('bank_transfer_links', {
  debitTransactionId: text('debit_transaction_id').primaryKey().references(() => transactions.id, { onDelete: 'cascade' }),
  targetAccountId: text('target_account_id'),
  creditTransactionId: text('credit_transaction_id').unique(),
  reversedAt: integer('reversed_at', { mode: 'timestamp_ms' }),
})

export const cards = sqliteTable('cards', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  accountId: text('account_id').notNull(),
  last4: text('last4').notNull(),
  kind: text('kind', { enum: ['debit', 'credit'] }).notNull(),
  status: text('status', { enum: ['active', 'locked', 'lost'] }).notNull(),
  dailyLimitCents: integer('daily_limit_cents').notNull(),
})

/** 卡片备注与信用账户信息；扩展表支持旧数据库无损升级。 */
export const bankCardProfiles = sqliteTable('bank_card_profiles', {
  cardId: text('card_id').primaryKey().references(() => cards.id, { onDelete: 'cascade' }),
  remark: text('remark').notNull().default(''),
  creditLimitCents: integer('credit_limit_cents').notNull().default(0),
  outstandingCents: integer('outstanding_cents').notNull().default(0),
  billDay: integer('bill_day').notNull().default(10),
  dueDay: integer('due_day').notNull().default(28),
})

export const subscriptions = sqliteTable('subscriptions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  merchant: text('merchant').notNull(),
  amountCents: integer('amount_cents').notNull(),
  cycle: text('cycle', { enum: ['monthly', 'yearly'] }).notNull(),
  status: text('status', { enum: ['active', 'cancelled'] }).notNull(),
  lastChargedAt: integer('last_charged_at', { mode: 'timestamp_ms' }),
  /** 扣费前提前提醒天数 */
  remindDays: integer('remind_days').notNull().default(3),
})

export const products = sqliteTable('products', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  riskRating: text('risk_rating', { enum: ['R1', 'R2', 'R3', 'R4', 'R5'] }).notNull(),
  expectedYield: real('expected_yield').notNull(), // 年化，如 0.025
  minAmountCents: integer('min_amount_cents').notNull(),
  termDays: integer('term_days').notNull(),
})

export const pendingActions = sqliteTable('pending_actions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  sessionId: text('session_id').notNull(),
  tool: text('tool').notNull(),
  argsJson: text('args_json').notNull(),
  paramsHash: text('params_hash').notNull(),
  level: text('level', { enum: ['yellow', 'red'] }).notNull(),
  reasonsJson: text('reasons_json').notNull(),
  summaryJson: text('summary_json').notNull(),
  integrity: text('integrity').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  status: text('status', {
    enum: ['pending', 'consumed', 'cancelled', 'expired'],
  }).notNull(),
  // 若来自 DAG，则确认后需恢复对应计划
  planId: text('plan_id'),
  nodeId: text('node_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

export const plans = sqliteTable('plans', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  sessionId: text('session_id').notNull(),
  stateJson: text('state_json').notNull(),
  status: text('status', {
    enum: ['running', 'suspended', 'paused', 'completed', 'failed', 'compensated', 'handoff'],
  }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

/** Which recipient warning was actually presented with this confirmation, independent of its base level. */
export const bankPendingRiskSnapshots = sqliteTable('bank_pending_risk_snapshots', {
  actionId: text('action_id').primaryKey().references(() => pendingActions.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull(),
  revision: integer('revision').notNull(),
})

/**
 * 仿真时钟：admin 后台可推进时间触发定时任务，key='clock' 存 ISO 时间串。
 * 未设置时默认使用 Date.now()。
 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

/**
 * 联系人（收款人扩展版）：比 payees 多 note/accountMask 字段，用于后台展示与 AA 分摊。
 * Agent 工具层同时支持 payees（精确银行账号）与 contacts（别名/备注搜索）两套语义。
 */
export const contacts = sqliteTable('contacts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  phone: text('phone').notNull(),
  /** 搜索关键词，如"爱人 老婆 生日" */
  note: text('note').notNull().default(''),
  bank: text('bank').notNull().default(''),
  /** 脱敏账号，仅展示用 */
  accountMask: text('account_mask').notNull().default(''),
})

/**
 * 理财持仓：申购后写入，赎回后 principal 归零。不计提收益，演示本金。
 */
export const holdings = sqliteTable('holdings', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  productId: text('product_id').notNull(),
  /** 持仓本金（分） */
  principalCents: integer('principal_cents').notNull(),
  /** 赎回解锁时间（ISO） */
  redeemableAt: text('redeemable_at').notNull(),
  createdAt: text('created_at').notNull(),
})

/**
 * 定时任务：定时转账、生日预留、生日订购等到期执行的异步任务。
 */
export const scheduledTasks = sqliteTable('scheduled_tasks', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  /** 'transfer' | 'birthdayReserve' | 'birthdayOrder' */
  kind: text('kind').notNull(),
  /** 'pending' | 'processing' | 'succeeded' | 'failed' | 'cancelled' */
  status: text('status').notNull(),
  /** 触发时间（ISO） */
  dueAt: text('due_at').notNull(),
  /** JSON 序列化的任务参数 */
  payloadJson: text('payload_json').notNull(),
  /** JSON 序列化的执行结果 */
  resultJson: text('result_json'),
  createdAt: text('created_at').notNull(),
})

/**
 * AA 分摊：发起人自动包含，shares 是 JSON 数组（每项含 contactId/amount/status）。
 */
export const splits = sqliteTable('splits', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  title: text('title').notNull(),
  /** 总金额（分） */
  totalCents: integer('total_cents').notNull(),
  /** JSON: [{contactId, amountCents, status}] */
  sharesJson: text('shares_json').notNull(),
  createdAt: text('created_at').notNull(),
})

/**
 * 生日计划：预留预算、生日前两天订购鲜花与蛋糕。
 */
export const birthdayPlans = sqliteTable('birthday_plans', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  contactId: text('contact_id').notNull(),
  birthday: text('birthday').notNull(),
  /** 预算（分） */
  budgetCents: integer('budget_cents').notNull(),
  /** 'planned' | 'reserved' | 'ordered' | 'completed' | 'cancelled' */
  status: text('status').notNull(),
  createdAt: text('created_at').notNull(),
})

/**
 * 生日计划订单：每笔礼品订购记录。
 */
export const birthdayOrders = sqliteTable('birthday_orders', {
  id: text('id').primaryKey(),
  planId: text('plan_id').notNull(),
  merchant: text('merchant').notNull(),
  item: text('item').notNull(),
  amountCents: integer('amount_cents').notNull(),
  deliveryDate: text('delivery_date').notNull(),
  /** 'pending' | 'confirmed' | 'delivered' */
  status: text('status').notNull(),
})

/**
 * 两阶段确认令牌：preview_* 签发，commit_* 校验后消费。
 * 绑定 RESOLVED entity ID 指纹，防止确认后篡改收款人/金额。
 */
export const confirmationTokens = sqliteTable('confirmation_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  /** 操作类型，如 'transfer'、'purchase' */
  operation: text('operation').notNull(),
  /** stableStringify(resolved params) 的 SHA-256 */
  paramHash: text('param_hash').notNull(),
  /** 面向用户的摘要快照（JSON），不经模型转述 */
  summaryJson: text('summary_json').notNull(),
  /** 权限层级 */
  tier: text('tier').notNull(),
  expiresAt: text('expires_at').notNull(),
  consumedAt: text('consumed_at'),
  createdAt: text('created_at').notNull(),
})

export const auditLogs = sqliteTable('audit_logs', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  at: integer('at', { mode: 'timestamp_ms' }).notNull(),
  userId: text('user_id').notNull(),
  sessionId: text('session_id').notNull(),
  channel: text('channel').notNull(),
  type: text('type').notNull(),
  payloadJson: text('payload_json').notNull(),
  prevHash: text('prev_hash').notNull(),
  hash: text('hash').notNull(),
})

/**
 * 安全内核演示用的篡改备份。
 *
 * 只服务于本地答辩演示：`tamperAuditLog` 故意改写一条审计记录的载荷（不动 hash 列），
 * 原值存到这里以便 `restoreAuditLog` 无损还原。**不是审计链的一部分**——
 * 它不参与哈希计算，因此篡改演示本身不会污染整链校验的结果。
 */
export const bankAuditTamperBackup = sqliteTable('bank_audit_tamper_backup', {
  seq: integer('seq').primaryKey(),
  payloadJson: text('payload_json').notNull(),
  hash: text('hash').notNull(),
  tamperedAt: integer('tampered_at', { mode: 'timestamp_ms' }).notNull(),
})

/**
 * 由 Agent 发起的交易密码修改凭证。
 *
 * 只存凭证本身，**不存密码**：工具 `request_password_change` 在用户完成红色强验证后签发，
 * 用户带着它到安全设置页亲自输入新密码，再由 `/api/security` 校验并单次消费。
 * 这样新密码永远不会出现在模型上下文、pending_actions 参数快照与审计日志中。
 */
export const bankPasswordChangeGrants = sqliteTable('bank_password_change_grants', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  /** 签发它的待确认操作编号，用于追溯"哪一笔确认授权了这次修改" */
  actionId: text('action_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
})

/**
 * 常设授权（standing mandate）：用户一次强验证，授权在有限期内按周期向固定收款人转固定金额。
 *
 * 安全属性都落在这张表上，由代码在每次执行时强制，不依赖模型：
 * - 金额固定为 amountCents（即"单次上限"），收款人用指纹锁定，改了就暂停；
 * - executionsDone / totalSpentCents 与 maxExecutions / maxTotalCents 在结算事务内条件更新；
 * - minIntervalHours 由频率推导，两次执行之间的硬间隔；
 * - expiresAt 到期自动失效，撤销立即生效。
 * 模型只能创建（红色强验证）、查询和撤销，没有任何触发执行的入口。
 */
export const bankStandingMandates = sqliteTable('bank_standing_mandates', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  fromAccountId: text('from_account_id').notNull(),
  payeeId: text('payee_id').notNull(),
  payeeName: text('payee_name').notNull(),
  payeeFingerprint: text('payee_fingerprint').notNull(),
  amountCents: integer('amount_cents').notNull(),
  memo: text('memo').notNull().default(''),
  cadenceJson: text('cadence_json').notNull(),
  maxExecutions: integer('max_executions').notNull(),
  maxTotalCents: integer('max_total_cents').notNull(),
  minIntervalHours: integer('min_interval_hours').notNull(),
  executionsDone: integer('executions_done').notNull().default(0),
  totalSpentCents: integer('total_spent_cents').notNull().default(0),
  failureCount: integer('failure_count').notNull().default(0),
  /** active | revoked | expired | exhausted | suspended */
  status: text('status').notNull(),
  /** 授权它的那一笔红色待确认动作；唯一，一笔确认只能产生一份授权 */
  authorizedActionId: text('authorized_action_id').notNull(),
    payeeRiskJson: text('payee_risk_json'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  nextDueAt: integer('next_due_at', { mode: 'timestamp_ms' }).notNull(),
  lastExecutedAt: integer('last_executed_at', { mode: 'timestamp_ms' }),
  endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
  endedReason: text('ended_reason'),
}, (t) => [uniqueIndex('bank_mandate_action').on(t.authorizedActionId)])

/** 每次执行一行；(mandateId, seq) 唯一，同一期不可能被执行两次 */
export const bankMandateExecutions = sqliteTable('bank_mandate_executions', {
  id: text('id').primaryKey(),
  mandateId: text('mandate_id').notNull(),
  seq: integer('seq').notNull(),
  transactionId: text('transaction_id').notNull(),
  amountCents: integer('amount_cents').notNull(),
  executedAt: integer('executed_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => [uniqueIndex('bank_mandate_seq').on(t.mandateId, t.seq)])

/** 后台 AI 只能追加 suspected，人工复核通过 revision CAS，不能由对话工具摘除。 */
export const bankRiskFlags = sqliteTable('bank_risk_flags', {
  accountId: text('account_id').primaryKey().references(() => accounts.id, { onDelete: 'cascade' }),
  status: text('status', { enum: ['suspected', 'confirmed', 'cleared'] }).notNull(),
  featuresJson: text('features_json').notNull(),
  reasonCodesJson: text('reason_codes_json').notNull(),
  snapshotHash: text('snapshot_hash').notNull(),
  source: text('source', { enum: ['ai', 'manual'] }).notNull(),
  revision: integer('revision').notNull().default(1),
  /** 只在人工复核时递增；用于拒绝复核前启动、复核后才返回的 AI 结果。 */
  reviewRevision: integer('review_revision').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  reviewedBy: text('reviewed_by'),
  reviewedAt: integer('reviewed_at', { mode: 'timestamp_ms' }),
})

/** worker 跨进程租约与冷却；模型不可用时只记失败，不阻断银行服务。 */
export const bankRiskAnalysisState = sqliteTable('bank_risk_analysis_state', {
  accountId: text('account_id').primaryKey().references(() => accounts.id, { onDelete: 'cascade' }),
  leaseToken: text('lease_token'),
  leaseUntil: integer('lease_until', { mode: 'timestamp_ms' }),
  nextRunAt: integer('next_run_at', { mode: 'timestamp_ms' }).notNull(),
  lastSnapshotHash: text('last_snapshot_hash'),
  lastStatus: text('last_status').notNull().default('idle'),
  lastErrorCode: text('last_error_code'),
  analyzedAt: integer('analyzed_at', { mode: 'timestamp_ms' }),
})

/**
 * 后台用户画像的文字缓存。只存文字与来源，不存任何指标：指标每次由代码重新计算，
 * `fingerprint` 是指标的哈希，数据变了指纹就变，旧文字不会冒充新数据。
 * 这张表**不被策略引擎、Agent 或数字核验读取**，画像文字永远不是证据。
 */
export const bankProfileNarratives = sqliteTable('bank_profile_narratives', {
  userId: text('user_id').primaryKey(),
  fingerprint: text('fingerprint').notNull(),
  text: text('text').notNull(),
  /** ai | rule：文字由模型还是确定性模板生成 */
  source: text('source').notNull(),
  /** 模型输出被拒绝的原因：numbers | invalid | unavailable */
  rejected: text('rejected'),
  generatedAt: integer('generated_at', { mode: 'timestamp_ms' }).notNull(),
})
