# 实时基金数据接入与理财专家：实施方案

> 实施更新（2026-10-20）：基金数据、未知价申购/T+1确认、只读专家与基础账户页展示已落地，运行方式见 [FUNDS.md](FUNDS.md)。下文保留原始完整规划，不能将未实现的赎回、冻结赎回份额、Tushare适配和12–20只扩容当作当前功能；当前白名单4只，仍保留原有银行理财产品。

> 2026-10-20 制定；已按上述阶段部分落地。本方案取代 [HANDOFF.md §5.1](HANDOFF.md) 中"在 `agent/run.ts` 内做意图路由"的写法，其余约束（专家只读、风险等级由代码判定、不签发确认单）全部沿用。
>
> 距 11.02 作品提交还有 13 天。完整方案约 12 天，**提交前建议只做第 9 节的 MVP**，其余留到 11.21 黑客马拉松前。

---

## 0. 先说三个实测事实（2026-10-20）

这三点直接决定了方案的形态，开工前请先认可：

1. **公募基金没有官方的"实时"价格。** 基金净值每个交易日只公布一次（晚间），所谓"实时"在业内指的是平台自行计算的**盘中估值**，不是官方数据。天天基金的盘中估值接口（`fundgz.1234567.com.cn`）**实测已返回 404，下线了**。所以本方案中的"实时"指：**最新公布净值 + 每晚自动刷新 + 页面标注数据日期**。演示和答辩时请统一这样表述。
2. **天天基金的历史净值接口仍可用。** `api.fund.eastmoney.com/f10/lsjz`（需要带 `Referer`）返回 JSON，包含单位净值、累计净值、日涨跌幅和**申购 / 赎回状态**。实测 `110011` 当前是"暂停申购"，说明申赎状态必须参与可买判断。
3. **公开数据里没有产品风险等级。** `pingzhongdata` 接口有名称、费率、起购金额、阶段收益和净值走势，但没有 R1–R5。这正好符合本项目的原则：**风险等级本来就不应该来自外部数据或模型**，见第 3.3 节。

另外：Tushare Pro 的 HTTP 接口可用，但需要 token，基金净值接口的积分门槛需要自行确认。

---

## 1. 范围

**做：**

- 接入一个人工维护的基金白名单（建议 12–20 只，不含货币基金），每晚刷新净值，缓存在本地数据库。
- 基金详情：净值走势、阶段收益、波动率、最大回撤，全部由代码从净值序列算出。
- 基金申购 / 赎回：在模拟银行内记账，按**未知价原则 T+1 确认份额**，持仓按最新净值估值。
- 理财专家：根据用户需求，从已通过风险匹配的候选里给出建议，指出需求之间的冲突，结果用固定组件 `AdviceCard` 展示。

**不做：**

- 不接盘中估值，不做秒级行情。
- 不让用户输入任意基金代码申购（只能买白名单里的）。
- 不做货币基金（万份收益、按日计息另成一套；已有 R1 的「活期宝 A」覆盖这类需求）。
- 不模拟分红再投资和份额拆分（见第 8 节已知局限）。
- 现有 3 个银行理财产品（`products` 表）**保持不动**，与基金并存。

---

## 2. 总体结构

```
┌ 数据层 ──────────────────────────────────────────────────────────┐
│ FundDataProvider 接口                                              │
│   ├─ eastmoney（默认）   ├─ fixture（离线快照）   └─ tushare（可选）   │
│ worker 每晚拉取 → zod 校验 → 同事务写入 bank_fund_navs              │
└──────────────────────────────┬──────────────────────────────────┘
┌ 产品层 ──────────────────────▼──────────────────────────────────┐
│ bank_funds：白名单 + 人工风险评级 + 申赎状态 + 费率                   │
│ 指标计算（纯函数）：阶段收益 / 年化波动 / 最大回撤 / 数据新鲜度        │
└──────────────────────────────┬──────────────────────────────────┘
┌ 交易层 ──────────────────────▼──────────────────────────────────┐
│ preview_fund_order → commit_fund_order（红色，复用确认链路）          │
│ 扣款即时、份额待确认 → worker 用首个 ≥ 交易日的净值确认份额            │
└──────────────────────────────┬──────────────────────────────────┘
┌ 理财专家 ────────────────────▼──────────────────────────────────┐
│ get_wealth_advice（只读、绿色）                                     │
│   代码：适当性过滤 → 指标 → 冲突检测 → 排序取候选                     │
│   模型：只拿到别名化的数字，挑选 ≤3 个并写理由                         │
│   代码：校验挑选范围、金额与百分比出处、禁用词 → AdviceCard            │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. 数据层

### 3.1 数据源

| 方案 | 现状（实测） | 优点 | 缺点 | 建议 |
|---|---|---|---|---|
| **天天基金公开接口** | `lsjz` 可用；`pingzhongdata` 可用；盘中估值已下线 | 免费、无需注册、字段齐全 | 非官方接口，无服务保证，可能随时变更 | **比赛默认使用** |
| Tushare Pro | 可用，需 token | 正规接口，有文档 | 需注册，基金接口有积分门槛（待确认） | 作为可选实现 |
| AKShare | — | 封装全面 | Python 库，本项目是 TypeScript；底层也是天天基金 | 不采用 |
| 离线快照 fixture | — | 现场断网也能演示 | 不是最新数据 | **必须实现**，作为兜底 |

生产环境应改用持牌数据源（如 Wind、iFinD、基金公司直连），这一点写进答辩口径即可，不在本次范围。

### 3.2 Provider 接口

```ts
// src/server/funds/provider.ts
export interface FundSnapshot {
  code: string
  name: string                    // 外部文本，入库前过 Guard，展示时视为数据
  purchaseStatus: 'open' | 'limited' | 'suspended'
  redeemStatus: 'open' | 'suspended'
  purchaseFeeRate: number         // 优惠后费率，0–0.05
  minPurchaseCents: number
  navs: { date: string; unitNav: number; accNav: number }[]  // 最近 N 个交易日
  source: 'eastmoney' | 'fixture' | 'tushare'
  fetchedAt: string
}
export interface FundDataProvider { fetch(code: string, signal: AbortSignal): Promise<FundSnapshot> }
```

`FUND_DATA_MODE=live|cache|fixture` 控制行为：

- `live`：worker 定时拉取；拉取失败时继续使用数据库缓存。
- `cache`：只读数据库，不联网（适合录屏）。
- `fixture`：从仓库内的快照文件加载（`fixtures/funds/*.json`，由 `scripts/fund-snapshot.mjs` 生成）。

### 3.3 风险等级：人工配置，不从外部推导

白名单写在 `src/server/funds/pool.ts`，每只基金的风险等级由**人工**填写，相当于模拟银行作为销售机构给出的评级：

```ts
export const FUND_POOL = [
  { code: '……', riskRating: 'R2', category: 'bond',   basis: '纯债基金，本行评级' },
  { code: '……', riskRating: 'R4', category: 'equity', basis: '偏股混合，本行评级' },
] as const
```

理由：

- 外部数据没有这个字段，而且外部文本不可信；
- 让模型推断等级违反 §0 约束 1；
- 真实银行的产品风险等级本来就由销售机构自行评定。

**具体选哪些基金**由团队确定，选好后用 `scripts/fund-snapshot.mjs --check` 逐只验证：能拉到数据、名称一致、当前开放申购。

### 3.4 数据表

所有金额用整数分，净值用整数（× 10⁴，保留 4 位小数），份额用整数（× 10²，保留 2 位小数），避免浮点误差。

```sql
bank_funds (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL,
  risk_rating TEXT NOT NULL,            -- 来自 pool.ts，不来自数据源
  purchase_status TEXT NOT NULL, redeem_status TEXT NOT NULL,
  purchase_fee_bp INTEGER NOT NULL, min_purchase_cents INTEGER NOT NULL,
  enabled INTEGER NOT NULL, source TEXT NOT NULL, updated_at INTEGER NOT NULL)

bank_fund_navs (
  code TEXT NOT NULL, nav_date TEXT NOT NULL,   -- 北京时间日期
  unit_nav_e4 INTEGER NOT NULL, acc_nav_e4 INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL, PRIMARY KEY (code, nav_date))

bank_fund_sync_state (
  code TEXT PRIMARY KEY, lease_token TEXT, lease_until INTEGER,
  next_run_at INTEGER NOT NULL, last_success_at INTEGER, last_error_code TEXT)
```

### 3.5 拉取与校验

- **调度**：工作日北京时间 20:00–23:30 每 30 分钟一次，另外在 worker 启动时补拉一次。每只基金用租约（与 `risk/accounts.ts` 相同的做法）防止多进程重复拉取。限速每秒 1 次，单次超时 8 秒。
- **网络请求放在事务外**：先拉取、解析、校验，通过后再开事务写库（§7 第 2 条）。
- **不执行远程 JS。** `pingzhongdata` 是一个约 600KB 的 JS 文件，只用正则提取 `fS_name`、`fund_Rate`、`fund_minsg` 等简单字符串变量，**禁止 `eval` / `new Function` / `import`**。净值统一从 `lsjz` 的 JSON 获取。单次响应超过 2MB 直接丢弃。
- **zod 校验**：净值在 (0, 1000) 内、日期不晚于今天、日期严格递增、费率在 0–5%；任何一项不通过，整只基金本次不写入，记录 `last_error_code`，保留旧数据。
- **名称核对**：与 `pool.ts` 中登记的名称不一致时暂停该基金（`enabled=0`），等待人工确认，防止代码被复用到其他基金。
- **新鲜度**：最新净值超过 3 个交易日未更新时，页面显示"数据可能过期"，并**暂停新的申购**。

---

## 4. 交易层

### 4.1 为什么用 T+1 确认

真实基金按**未知价原则**成交：下单时不知道成交净值，15:00 前下单按当日净值确认，之后按下一个交易日净值。照此实现有两个好处：

- 评委是银行的人，按真实规则做比"即时按最新净值成交"更可信；
- 不需要交易日历：worker 只需找**第一个日期 ≥ 生效交易日**的已公布净值，周末和节假日自然顺延。

### 4.2 数据表

```sql
bank_fund_orders (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, action_id TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL, side TEXT NOT NULL,          -- buy | sell
  amount_cents INTEGER, shares_e2 INTEGER,          -- 申购按金额，赎回按份额
  account_id TEXT NOT NULL, trade_date TEXT NOT NULL,
  status TEXT NOT NULL,                             -- submitted | confirmed | failed | cancelled
  nav_date TEXT, unit_nav_e4 INTEGER, fee_cents INTEGER,
  transaction_id TEXT, created_at INTEGER NOT NULL, confirmed_at INTEGER)

bank_fund_positions (
  user_id TEXT NOT NULL, code TEXT NOT NULL,
  shares_e2 INTEGER NOT NULL, frozen_shares_e2 INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL, PRIMARY KEY (user_id, code))
```

### 4.3 流程

**申购**

1. `preview_fund_order`（只读）：检查白名单、申购状态、数据新鲜度、起购金额、`riskGate`，签发业务预览令牌。
2. `commit_fund_order`：**基础等级红色**（赛题把理财申购列为红色），走现有的待确认动作与强验证链路。
3. 确认执行时：同一事务内扣款、写流水（分类 `理财`）、建订单 `submitted`。确认单上写明"按 T 日净值确认，T+1 可查份额"。
4. worker：找到首个 `nav_date ≥ trade_date` 的净值后，计算 `份额 = 金额 ÷ (1 + 费率) ÷ 净值`（净额法），同一事务内把订单改为 `confirmed` 并增加持仓。

**赎回**

1. 按份额赎回，确认时先冻结份额（`frozen_shares_e2`），防止重复卖出。
2. worker 用 T 日净值算出金额，扣除赎回费后入账，解冻并扣减份额。
3. 赎回费：持有不足 7 天按 1.5%（证监会规定的惩罚性赎回费）；其余按数据源公布的费率，拿不到时按 0 处理，并在回执上注明"未计赎回费"。

**补偿（DAG 回滚）**

- 订单仍是 `submitted`：撤单并原路退款，幂等。
- 已经 `confirmed`：不能自动回退，计划进入 `failed` 并转人工（与现有理财补偿的处理方式一致）。

### 4.4 需要同步修改的地方

| 位置 | 改动 |
|---|---|
| `server/dashboard.ts` | 总资产加上基金市值（份额 × 最新净值）和在途申购金额 |
| `server/profile/profile.ts`（#7） | 理财占比、持仓风险结构纳入基金 |
| `admin` 后台 | 理财视图展示基金订单与持仓；新增"基金数据状态"（最新净值日期、拉取错误） |
| `security/kernel.ts` | 可选：在安全事件计数中展示数据拉取失败次数 |

---

## 5. 理财专家

### 5.1 触发方式（与 HANDOFF §5.1 的差异）

原方案是在 `agent/run.ts` 里先分类意图再路由。现在改为**由主 Agent 调用一个只读工具** `get_wealth_advice`：

- 不需要额外的意图分类调用；
- 专家只在工具内部运行，输入和输出都有 schema，审计更清楚；
- 用户的需求由主模型整理成结构化参数。按 §11.0 判据 1，这属于"事实"而不是"策略"，可以来自模型。

### 5.2 工具输入

```ts
get_wealth_advice({
  amountYuan?: number,         // 必须出现在当前这条用户消息里（复用 requestedAmounts 校验）
  horizon: 'within_3m' | '3_12m' | '1_3y' | 'over_3y' | 'unknown',
  liquidity: 'anytime' | 'partial' | 'locked_ok' | 'unknown',
  preference: 'preserve' | 'balanced' | 'growth' | 'unknown',
  targetReturnPct?: number,    // 同样必须出现在当前用户消息里
  purpose?: 'emergency' | 'education' | 'home' | 'retire' | 'general',
})
```

缺少关键信息（期限、流动性）时，工具返回 `needs_information` 和缺什么，由主 Agent 追问，或调用现有的 `ask_questions` 出选择题。

### 5.3 代码负责的部分（确定性，可单测）

1. **适当性**：调用 `riskGate`。测评缺失或已超过一年时，只返回"请先完成风险测评"，并附测评入口，**不展示任何产品**。
2. **可投资金额**：复用 #7 的 `buildProfileMetrics`，`可投资金额 = 活期余额 − 6 × 月均支出`（下限为 0）。
3. **候选池**：白名单基金（开放申购、数据新鲜）加上现有银行理财产品。
4. **硬过滤**：风险等级不高于用户等级；要求"随时可取"时只保留期限为 0 的产品和债券类基金；期限在 3 个月以内时排除 R4 及以上；起购金额不超过投入金额。
5. **指标**：近 1 月 / 3 月 / 6 月 / 1 年收益率、年化波动率、近 1 年最大回撤，均由净值序列算出，并附数据日期。收益率用累计净值计算，避免分红日的单位净值下跌被误判为亏损。
6. **冲突检测**（每条都是代码规则）：

   | 冲突 | 判定 |
   |---|---|
   | 投入超过可投资金额 | `amount > investable` |
   | 期限短但偏好高收益 | `horizon=within_3m` 且 `preference=growth` |
   | 要求随时可取又要高收益 | `liquidity=anytime` 且 `preference=growth` |
   | 目标收益不现实 | `targetReturnPct` 高于所有合格候选的近 1 年收益 |
   | 需求超出风险等级 | 偏好 `growth`，但用户等级 ≤ R2 |

7. **排序**：`preserve` 按最大回撤从小到大；`balanced` 按近 1 年收益 ÷ 波动率；`growth` 按近 1 年收益，但最大回撤超过 25% 的排除。取前 5 个进入候选清单。

### 5.4 模型负责的部分（受限）

- 使用独立的系统提示词和 `agentModel()`，与主对话分开调用（与 #7 画像文案、#1 风险分析同一模式）。
- **输入只有数字和固定枚举。** 基金名称是外部文本，**不交给模型**；候选以"候选1 / 候选2 …"的别名出现，展示时再由服务端换回真实名称。即使基金名称里藏了指令，也进不了模型。
- 输出 schema：

  ```ts
  { picks: { candidate: '候选1'|…|'候选5', role: 'core'|'satellite'|'alternative',
             reasons: ReasonCode[], note: string /* ≤ 80 字 */ }[],   // 最多 3 个
    summary: string,          // ≤ 160 字
    conflictNotes: string[] } // 只能解释代码给出的冲突，不能新增
  ```

### 5.5 服务端把关

任何一项不通过，丢弃模型输出，改用代码生成的规则文案，并标注来源：

- `picks` 必须属于候选清单，且不超过 3 个；
- 文中的金额和**百分比**必须能在输入的指标里找到（见 5.7）；
- 禁用表述：`保本|稳赚|保证收益|一定|肯定|无风险|必涨|稳赚不赔`；
- 不得出现风险等级判断（如"您适合 R4"），等级只能由代码展示。

### 5.6 展示：AdviceCard（固定组件）

- **代码给出的数据**：候选名称、本行风险评级、阶段收益、波动、回撤、数据日期和来源、冲突列表。
- **专家文字**：标注"理财专家（AI）生成"。
- **固定合规文案**（不经模型）："基金有风险，投资需谨慎。过往业绩不预示未来表现。数据来源：天天基金网公开数据，截至 YYYY-MM-DD。本系统为模拟银行，申购不涉及真实资金与基金份额。风险等级为本行（模拟）评级。"
- **按钮**：「查看详情」「用 N 元申购」。点击后以用户身份发送一条消息，重新走 意图 → 策略 → 红色确认，**卡片本身不能下单**（§9 第 3 条）。

### 5.7 防幻觉：补上百分比核验

现在的 `verifyNumbers` 只核验带"¥ / 元"的金额和卡尾号，**不核验百分比**。模型完全可以写"近一年收益 18%"而不被拦截，基金场景必须补上：

- 工具输出统一提供已经是百分数的字段（如 `return1yPct: 12.34`），这样 `collectEvidence` 现有逻辑就能收集到；
- 新增百分比核验，**先只用于专家输出**，跑通后再评估是否推广到主对话。

上一次 review 发现流水核验误拦了单日合计，所以全局开启前必须先把含百分比的现有回复样本（储蓄率、涨跌幅等）跑一遍，确认不会误拦。

### 5.8 审计

新增审计类型 `wealth_advice`，载荷包括：`expert: 'wealth'`、输入参数、候选清单 ID、模型挑选结果、是否退回规则文案及原因、模型名称。`AgentContext` 增加 `expert?: 'general' | 'wealth'`，决策链追踪页可以显示"由理财专家生成"。

---

## 6. 前端

| 页面 / 组件 | 内容 | 复用 |
|---|---|---|
| 理财页：基金列表 | 名称、本行评级、最新净值和日期、近 1 年收益、申购状态 | 现有 `Card`、`Badge`、`Table` |
| 基金详情 Sheet | 净值走势、阶段收益、回撤、费率、合规文案 | `Sheet`；走势图用已有的 `recharts` |
| 持仓 | 份额、市值、浮动盈亏、在途订单 | `BankCard` 风格 |
| `AdviceCard` | 第 5.6 节 | 新组件，放在 `components/chat/` |
| 后台：基金数据状态 | 每只基金的最新净值日期、拉取错误、启用状态 | `admin` 视图 |

---

## 7. 安全红线（对照 §0 和 §11.0）

1. **风险等级只来自 `pool.ts` 的人工配置和 `riskGate`。** 数据源和模型都不能提供或修改等级。
2. **基金名称等外部文本不进模型**（别名化），进入主对话时也要经过 `quarantineForModel`。
3. **外部数字必须先校验才能入库**，入库后才能成为核验出处；模型写的文字永远不能成为出处。
4. **成交净值由 worker 按规则确定**，不来自模型，也不来自用户输入。
5. **网络请求不放进数据库事务**；**不执行远程 JS**。
6. **专家没有写工具**，卡片按钮只能发送用户消息。
7. **表述诚实**：不说"实时行情"，说"最新公布净值，截至 某日"；不说"真实申购"，说"模拟银行内申购"。

---

## 8. 已知局限（写进文档，答辩时可主动说明）

- 不模拟分红和拆分：持仓用单位净值估值，分红日会出现一次虚假下跌。收益率指标用累计净值计算，不受影响。
- 赎回费只区分"不足 7 天"和数据源公布的统一费率，不做分段费率。
- 模拟时钟与真实净值日期可能不一致：在手动推进时钟模式下，如果模拟日期晚于最新公布的净值日期，订单会一直等待确认。**演示请使用自动时钟模式**，或提前准备一笔已确认的订单。
- 天天基金接口没有服务保证。现场以 fixture / cache 模式兜底。

---

## 9. 分阶段实施与复杂度

复杂度与模型建议沿用 [HANDOFF.md §12](HANDOFF.md) 的标准。

| 阶段 | 内容 | 工期 | 复杂度 | 模型 · effort |
|---|---|---|---|---|
| **P1 数据层** | Provider 接口、eastmoney 与 fixture 实现、三张表、worker 调度与租约、zod 校验、`pool.ts`、快照脚本 | 2–3 天 | 中等；校验与入库部分属于复杂 | Sonnet · `high`；校验与入库用 Opus · `high` 审查 |
| **P2 交易层** | 订单与持仓表、preview/commit 工具、T+1 确认、赎回冻结、费率、补偿、首页与画像估值 | 3–4 天 | **复杂**（资金移动加异步结算，与 #8 同类） | Opus · `high`；结算状态机设计用 `xhigh` |
| **P3 理财专家** | 确定性流水线、冲突规则、专家模型调用、别名化、百分比核验、规则文案兜底、审计 | 3 天 | 复杂 | Opus · `high` |
| **P4 前端** | 基金列表、详情、持仓、AdviceCard、后台数据状态 | 2 天 | 中等 | Sonnet · `medium` |
| **P5 收尾** | 测试补齐、DEMO.md 新增一幕、文档 | 1 天 | 简单 | Sonnet · `low` |

**合计约 11–13 天。**

### 11.02 前的 MVP（约 8 天）

- P1 全部；
- P2 只做**申购 + T+1 确认 + 持仓估值**，赎回留到之后；
- P3 全部；
- P4 只做 AdviceCard、基金详情和持仓；
- 演示前用 fixture 模式彩排一遍。

赎回、后台数据状态视图、Tushare 实现，放到 11.21 黑客马拉松之前完成。

---

## 10. 测试清单

- **数据层**：畸形 JSON、净值越界、日期倒序、名称不一致、超时、响应超过 2MB 时都不写入且保留旧数据；租约防重复拉取；fixture 模式离线可用。
- **适当性**：未测评 / 测评过期时不返回任何产品；高于用户等级的基金永远不进候选；修改模型输出也无法让不合格基金出现。
- **专家把关**：越界挑选、编造百分比、禁用词、出现等级判断，都会退回规则文案；基金名称含注入文本时，模型输入中不出现该文本。
- **交易**：T+1 用首个 ≥ 交易日的净值确认；15:00 截止线；周末顺延；并发确认只成功一次；补偿幂等；赎回冻结防止超卖；数据过期时禁止申购。
- **估值**：首页总资产、画像理财占比计入基金市值与在途金额。
- **回归**：全量测试在独立库上通过；百分比核验推广到主对话前，用现有样本确认不误拦。

---

## 11. 需要你确认的事项

| 事项 | 选项 | 我的建议 |
|---|---|---|
| 数据源 | 天天基金公开接口 / Tushare Pro | **天天基金**，再加 fixture 兜底；Tushare 作为后续可选 |
| 成交方式 | T+1 未知价确认 / 按最新净值即时成交 | **T+1**，更符合真实规则；演示时提前准备一笔已确认的订单 |
| 基金池 | 人工白名单 12–20 只 / 允许任意代码 | **白名单**，并且不含货币基金 |
| 11.02 前的范围 | 第 9 节 MVP / 完整方案 | **MVP** |
| 白名单具体名单与评级 | 由团队选定 | 建议债券类、混合类、指数类各 4–6 只 |

确认以上事项后即可按 P1 开工。
