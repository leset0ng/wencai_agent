# 文财 · 银行 AI 智能体

用户端、Agent 与后台已合入 **shadcn / Base UI + Motion** UI，保留文财蓝白视觉，以及原版新增的定期转账授权、模型故障切换和计划中断机制。组件架构、动效复用方式与合并验证见 [UI 迁移说明](docs/UI-MIGRATION.md)。Windows 双击 [start.bat](start.bat)，或运行 `pnpm dev` 启动网页、后台任务和实时日志。

用自然语言办理银行业务的 AI Banking Agent。核心原则：**大模型负责理解与提议，确定性代码负责授权与执行。**

架构与安全设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)；**安全机制的完整说明、测试覆盖与已知缺陷见 [docs/SECURITY.md](docs/SECURITY.md)（安全自评报告）**；当前源码调用链、开发入口、Windows 启动步骤和待办见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。**接手本项目请先读 [docs/HANDOFF.md](docs/HANDOFF.md)**：四条硬约束、代码地图、两类令牌的区别、已知的坑与当前优先级都在那里。演示或录屏前先看 [docs/DEMO.md](docs/DEMO.md)：分镜、固定话术、录屏方法与现场兜底。全部 29 份文档的分类与主次见 [docs/README.md](docs/README.md)。

## 快速开始

Windows 可直接双击根目录的 `start.bat`：自动加载 `.env.local`、检查依赖、启动服务并打开浏览器。启动窗口就是实时日志窗口，日志同时保存在 `.scratch/logs/`；按 `Ctrl+C` 停止服务。端口优先读取本地 `PORT`，未配置时为 3000；端口占用时自动顺延，并使用日志中显示的实际地址。

首次运行会从 `.env.example` 创建本地配置并生成签名密钥；填写 `DEEPSEEK_API_KEY` 后重启即可启用 Agent，默认模型为 `deepseek-flash`。只有数据库文件不存在时才自动建表并播种，已有数据库不会被重新播种。`.env.local`、数据库与日志均不上传 Git。

手动启动方式：

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env.local  # 填入至少 16 位的 CONFIRM_SECRET 和模型配置
New-Item -ItemType Directory -Force data | Out-Null
pnpm exec node --env-file=.env.local ./node_modules/drizzle-kit/bin.cjs push
pnpm exec node --env-file=.env.local --import=tsx src/server/db/seed.ts
pnpm dev
```

以上适用于首次初始化；播种会重建演示数据。服务端从进程环境变量读取配置，上述命令显式加载 `.env.local`。环境变量已经注入时可直接使用下方快捷命令。

登录用手机号验证码（演示环境验证码打印在服务端日志）：

| 手机号 | 用户 | 交易密码 |
|---|---|---|
| `13800000000` | 张小明 | `123456` |
| `13800000001` | 李小萌 | `654321` |

第二个账号用于演示越权防护：登录态 A 拿不到 B 的任何数据。

## 常用命令

Google VM 的 HTTPS 演示部署、生产启动与日志操作见 [部署说明](docs/GOOGLEVM.md)。本机双击 `open-googlevm-logs.bat` 可查看云端文财项目实时日志；关闭日志窗口不会停止云端项目。

| 命令 | 说明 |
|---|---|
| `pnpm dev` | 启动 Web/H5、后台任务与实时日志 |
| `pnpm dev:web` | 仅启动网页（已有环境变量时使用） |
| `pnpm test` | 单元测试与红队用例（策略、令牌、审计链、执行器、注入、沙箱、生成式 UI、越权） |
| `pnpm typecheck` | 类型检查 |
| `pnpm db:reset` | POSIX shell 下重建数据库并写入演示数据；Windows 见上方步骤 |
| `pnpm bot:lark` | 启动飞书机器人（需 `LARK_APP_ID` / `LARK_APP_SECRET`） |
| `pnpm mcp` | 以 stdio 启动 MCP Server（仅只读工具） |

## 用户首页与可复用动效

登录后进入蓝白色银行首页：真实资产、收支、银行卡、最近交易，以及账户、生活、我的四个栏目。「问文财」悬浮入口可自由拖动，点击展开接近全屏的 Agent 面板，保留原有流式对话、工具查询和交易确认流程。

首页、Agent 工具结果和生成式视图共用 `src/components/ui/` 中的银行卡、纵向柱图、环形图、入场和金额组件：卡片前推、柱形逐条上升、圆环顺时针展开，支持悬停、点击、键盘聚焦与系统减少动态效果设置。复用方式见 [开发导读](docs/DEVELOPMENT.md#用户界面与动效复用)。

## 转账与收款人

首页点击“转账”，可选择已保存收款人或本人账户互转；账户栏目也提供转账和收款人入口。新增收款人支持完整手机号查找，或完整文财账号＋户名核对，选定账户后确认添加。转账需核对确认，新收款人需交易密码。

文财系统内账户实时双边记账：A 扣款、B 入账，双方各有流水；“收款”可查看并复制本人的账号与户名。账号首次使用时自动生成并持久保存，已有数据库会无损增加扩展表。旧外部银行卡收款人仍为模拟转出，系统没有接入真实银行。

## 银行管理后台

新增「收款风险复核」：后台 AI 只提供疑似线索，代码负责强验证升级，人工确认高危后拒绝转账；人工解除与每次判定均可审计。实现与独立演示步骤见 [收款风险分析](docs/RECIPIENT-RISK.md)。

启动地址的 `/admin` 首页展示全部银行用户与注册用户，支持按姓名、手机号或用户 ID 搜索，并显示账户数、总余额和风险等级。点击「登录账户」进入指定用户的管理界面，右上角或侧栏可返回首页切换账户。

这是面向银行运营/演示的管理后台（不是用户端），可直接查看和操作所选用户的模拟银行数据：账户总览、流水与异常、转账与 AA、理财、卡片、订阅、生日计划、仿真时钟、操作审计。账户切换只改变后台管理对象，不创建用户端登录会话；各用户的查询缓存、命令与审计均携带对应用户标识。

- 后台走 `/api/admin`，**不经过策略引擎与确认令牌**，是人工直连通道；每条命令都写入哈希链审计（类型 `admin_command`）。
- **没有登录鉴权**，只适合本地演示。`NODE_ENV=production` 时默认关闭，显式设置 `ADMIN_ENABLED=true` 可开启。
- 「推进时间」只向前推进仿真时钟，并执行到期的定时转账。

## 工具层

银行工具注册表共 89 个工具（54 个 read、35 个 write）。实际 Web/飞书 Agent 暴露 88 个（54 个 read、34 个 write），其中旧 `request_password_change` 已从 Agent 白名单移除；MCP 只暴露 54 个只读工具。此计数不包含 `ask_questions`、`show_view` 等会话辅助工具，也不包含后台仿真控制。扩展部分采用**两段式确认**：

```
resolve_recipient → check_transfer_limit → preview_transfer（签发令牌，只读）→ commit_transfer（策略引擎拦截 → 用户确认 → 校验并消费令牌）
```

预览令牌绑定 操作类型 + 已解析实体 ID 的参数指纹 + 用户，15 分钟有效。改金额、换收款人、重放、跨用户、过期会被拒绝，见 `tests/confirmation-token.test.ts`；条件更新防止并发重复消费。用户确认另由 HMAC 待确认动作控制，默认有效期 300 秒。

`transfer` 与 `commit_transfer` 均已接入转账风险升级：日累计超过1000元升级为红色；单笔超过3000元或可疑收款账户要求交易密码加指纹/人脸演示验证，确认执行前重新判定。AA 由参与人本人付款，不能由发起人登记到账；旧 `settleSplit` 实现已删除。飞书确认缺少银行卡/资金账户验证或需追加验证时，返回原确认单 H5 链接，登录同一账户完成独立安全验证后才能执行。其他实现边界见 [开发导读第 8 节](docs/DEVELOPMENT.md#8-当前实现边界与优先事项)。

## 用户与权限

- **身份**：手机号 + 验证码登录（better-auth + phone-number 插件），会话存库。未登录调用 `/api/dashboard`、`/api/chat`、`/api/confirm` 一律 401。
- **强验证**：红色操作用交易密码（scrypt）或 Passkey（WebAuthn）。5 次失败锁定 30 分钟。
- **渠道绑定**：飞书账号需在 `/bind` 完成一次强验证后才可代办业务，未绑定账号查不到任何数据。
- **设备管理**：`/settings` 可查看并踢掉其他登录会话、解绑渠道、注册 Passkey。

详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 第 3、4 节。

## 技术栈

TanStack Start · Vercel AI SDK v7 · DeepSeek / OpenAI 兼容模型接口 · Qwen3Guard · json-render · Chat SDK（飞书） · MCP · SQLite + Drizzle · QuickJS 沙箱 · Vitest
