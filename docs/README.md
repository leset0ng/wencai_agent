# 文档索引

> 2026-10-24 整理。共 29 份文档，按用途分组；每组标出**主文档**，其余为专题补充或历史记录。
> 内容冲突时以**代码**为准，其次以较新的主文档为准。

## 先读这几份

| 文档 | 用途 | 状态 |
|---|---|---|
| [../README.md](../README.md) | 快速开始、工具层概览、用户与权限 | 主文档 |
| [HANDOFF.md](HANDOFF.md) | 接手必读：四条硬约束、代码地图、实现坑点、待办优先级、完成记录、复杂度与模型选择 | **主文档** |
| [SECURITY.md](SECURITY.md) | 安全设计与自评报告：各机制实现与状态、测试覆盖、未完成项与已知缺陷、对外表述口径 | **主文档** |
| [DEMO.md](DEMO.md) | 演示分镜、固定话术、录屏方法、现场兜底 | 主文档 |
| [COMPETITION-COMPLIANCE.md](COMPETITION-COMPLIANCE.md) | 赛题场景与要求的逐项对应 | ⚠️ 2026-10-12 版本，未包含之后的生活商城、基金、常设授权等，以 HANDOFF 为准 |

## 架构与开发

| 文档 | 用途 | 状态 |
|---|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | 设计原则、分层与技术选型理由 | 设计意图仍有效；工具数量等实现细节已过时（v0.2，2026-10-11） |
| [DEVELOPMENT.md](DEVELOPMENT.md) | 源码调用链、开发入口、Windows 启动、按日期的变更记录 | 调用链仍有效；后半部分是 2026-10-12 前的变更流水 |
| [UI-INTERACTION-STRUCTURE.md](UI-INTERACTION-STRUCTURE.md) | 前端组件结构图 | Agent 交互的**主文档** |

## 安全与验证

主文档：[SECURITY.md](SECURITY.md)。以下为专题细节：

| 文档 | 内容 |
|---|---|
| [AUTH-CARDS.md](AUTH-CARDS.md) | 注册、每张卡独立交易密码、独立安全页面 |
| [DESKTOP-SECURITY.md](DESKTOP-SECURITY.md) | 桌面端安全验证窗口的布局 |
| [RECIPIENT-RISK.md](RECIPIENT-RISK.md) | 收款账户风险标记与人工复核（HANDOFF #1） |
| [HTTPS-ORIGIN-FIX.md](HTTPS-ORIGIN-FIX.md) | HTTPS 反向代理下"请求来源无效"的修复与来源校验规则 |

## Agent 交互

主文档：[UI-INTERACTION-STRUCTURE.md](UI-INTERACTION-STRUCTURE.md)。以下三份主题重叠，后续应合并：

| 文档 | 内容 |
|---|---|
| [AGENT-INTERACTIONS.md](AGENT-INTERACTIONS.md) | 可复用选择交互、`prepare_interaction` 模板 |
| [AGENT-UI-INTERACTIONS.md](AGENT-UI-INTERACTIONS.md) | 只读展示、业务选择与问卷的区分 |
| [BATCH-TRANSFERS.md](BATCH-TRANSFERS.md) | 多笔转账交互 |

其他专题：

| 文档 | 内容 |
|---|---|
| [AGENT-PROGRESS.md](AGENT-PROGRESS.md) | Agent 处理状态卡 |
| [MOBILE-AGENT.md](MOBILE-AGENT.md) | 手机端键盘适配 |
| [TRANSACTION-QUERY.md](TRANSACTION-QUERY.md) | 账单查询的北京时间口径 |

## 理财与基金

主文档：[FUNDS.md](FUNDS.md)。

| 文档 | 内容 | 状态 |
|---|---|---|
| [FUNDS.md](FUNDS.md) | 基金数据接入、未知价申购与 T+1 确认、只读理财专家 | **主文档** |
| [WEALTH-MARKET.md](WEALTH-MARKET.md) | 理财排行页与九周期指标口径 | 专题 |
| [FUND-CATALOG.md](FUND-CATALOG.md) | 基金池扩充与偏好推荐 | 专题 |
| [WEALTH-FUND-PLAN.md](WEALTH-FUND-PLAN.md) | 最初的实施方案 | 历史方案；已部分落地，基金赎回等仍未实现 |

## 其他业务

| 文档 | 内容 |
|---|---|
| [LIFE-MARKET.md](LIFE-MARKET.md) | 生活商城与订阅管理 |
| [PROFILE.md](PROFILE.md) | 后台用户画像（HANDOFF #7） |

## 界面

| 文档 | 内容 |
|---|---|
| [UI-MIGRATION.md](UI-MIGRATION.md) | 迁移到 shadcn / Base UI + Motion 的过程与合并记录 |
| [DESKTOP-UI.md](DESKTOP-UI.md) | 桌面端布局 |
| [DARK-MODE.md](DARK-MODE.md) | 黑夜模式 |

## 部署与运维

| 文档 | 内容 |
|---|---|
| [GOOGLEVM.md](GOOGLEVM.md) | Google VM 演示部署与日志 |
| [SQLITE-BUSY-RECOVERY.md](SQLITE-BUSY-RECOVERY.md) | 本地 SQLite 提交失败（`SQLITE_BUSY`）的修复 |
| [HTTPS-ORIGIN-FIX.md](HTTPS-ORIGIN-FIX.md) | 见"安全与验证" |

## 历史记录

| 文档 | 内容 |
|---|---|
| [UPSTREAM-MERGE.md](UPSTREAM-MERGE.md) | 2026-10-17 与原仓库的合并记录 |

---

## 维护约定

- **新功能**：优先补充到对应分组的主文档；确需单独成文时，在本索引登记并注明属于哪个主文档。
- **完成记录**：写入 [HANDOFF.md §10](HANDOFF.md)；与安全相关的同时更新 [SECURITY.md](SECURITY.md) 的状态标记。
- **待合并**：Agent 交互三份文档、基金三份专题文档、DEVELOPMENT.md 后半部分的变更流水，计划在比赛后整理（见 HANDOFF §6）。
