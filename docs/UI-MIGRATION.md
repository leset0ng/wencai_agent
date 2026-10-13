# UI 迁移副本

## 范围与隔离

本副本位于 `E:\Finance\wencai_agent_shadcn`，从原项目 `07a5e35` 复制，分支为 `ui/shadcn-motion`。迁移覆盖用户端、登录/绑定/设置、Agent 生成式视图，以及管理后台。原项目的页面、配置和数据库不由本次迁移修改；复制之后原项目的新提交也不会自动进入本副本。

本地 `.env.local` 使用独立的 `data/bank.db`、确认签名密钥和 3018 端口。数据库通过 SQLite 一致性快照复制，没有重新播种。配置、数据库、日志、截图和临时测试库均不进入版本控制。运行中的后台任务只连接副本数据库。

双击根目录 `start.bat` 启动并打开实时日志；日志中显示实际地址。本副本的 Git origin 仍指向本地原仓库，未推送迁移内容；需要发布时应先明确目标远程仓库。

## 组件结构

采用 shadcn 的本地组件组织与组合方式，交互基础为 Base UI。为保留文财的皮肤，组件经过手工适配，并非直接套用默认主题。`components.json` 提供后续 shadcn 工具使用的目录与主题配置；新增组件前应检查是否会覆盖这些适配。

| 位置 | 责任 |
| --- | --- |
| `src/components/ui/button.tsx` | Base UI 按钮、变体、悬浮/按压/键盘聚焦反馈 |
| `input.tsx`、`select.tsx`、`checkbox.tsx` | 统一表单控件，保留表单校验与键盘操作 |
| `dialog.tsx`、`Sheet.tsx` | 后台对话框、银行上拉面板、焦点管理、Escape 与白条下拉 |
| `tabs.tsx`、`toggle-group.tsx` | 底部栏目、图表类型、业务方式与报表周期切换 |
| `card.tsx`、`badge.tsx`、`table.tsx` | 卡片、状态徽标、表格与结果行入场 |
| `carousel.tsx`、`banking/AccountCarousel.tsx` | Embla 单卡轮播；选中卡片 ID 驱动对应账户的账单查询 |
| `provider.tsx`、`motion.tsx` | 全局 Motion 配置、入场、金额变化、消息、思考动画与图表揭示 |
| `charts.tsx`、`BankCard.tsx` | 共享柱图、环图、银行卡前推动画 |
| `DraggableFloatingButton.tsx` | Agent 拖动边界、位置保持与拖动后抑制误点击 |
| `primitives.css`、`src/lib/utils.ts` | 蓝白主题令牌、控件皮肤和类名合并 |

依赖锁定版本：Base UI 1.9.0、Motion 14.1.0、Embla Carousel 8.6.0；增加 cva、clsx、tailwind-merge。业务服务、策略引擎、确认令牌和账务执行逻辑保持原有实现。

## 后续开发约定

页面中的按钮、输入框、选择器、复选框、对话框、栏目切换和表格从 `#/components/ui/` 引入。已有 `className` 保留原皮肤；未传 `className` 的 Button 使用基础变体，默认 `type="button"`，提交按钮应显式写 `type="submit"`。`SelectControl` 使用 `SelectOption` 声明选项，通过 `onValueChange` 获取值。

新增弹出页面使用 `Sheet`，不要另写一份手势：它统一处理顶部白条拖动、键盘收起、焦点与保留子树。Agent 对话因此在收起后保留草稿和消息。后台操作弹窗使用 `DialogContent`，提交过程中保留原有禁止关闭的行为。

图表统一使用 `AnimatedBarChart` / `AnimatedDonutChart`。柱形逐条从底部展开，环形各段沿顺时针顺序绘制；同一组数据的普通重渲染不会重新播放，数据更新或重新挂载会播放。首页、账单面板与 Agent 的工具/生成式视图复用同一套组件。卡片、按钮和消息的核心变换交给 Motion，避免同时添加旧 CSS transform 动画。

减少动态效果跟随操作系统设置：金额与图表直接显示终态，面板和控件省去位移。现有布局、渐变、阴影、静态 SVG 图案及少量装饰动画仍由 CSS 管理，这有助于保留原视觉，不需要为了迁移重写为另一套默认皮肤。

## 验证记录

- 完整测试：27 个文件、234 个用例通过。测试使用 `.scratch/ui-migration-final.db`，独立于预览数据库。
- 修正了一个依赖运行时刻的日累计转账测试：只冻结该用例的日期为 UTC+8 正午，避免夜间风险升级干扰；没有降低生产安全策略。
- 浏览器验证：手机号登录、四张卡显示、单卡拖动与对应账单同步、付款账户选择、白条拖动收起、Agent 草稿保留、悬浮入口拖动不误打开、柱图/环图切换、系统减少动态效果、后台用户选择与操作弹窗 Escape 收起。
- Agent 实际只读查询「帮我分析本月支出并用图表展示分类」成功，结果显示单份分类环图与分析文字。
- 类型检查与生产构建通过；构建仍有现有包体积提示，可在后续按路由拆分优化。

参考：[shadcn Base UI Button](https://ui.shadcn.com/docs/components/base/button)、[Carousel](https://ui.shadcn.com/docs/components/base/carousel)、[Base UI Dialog](https://base-ui.com/react/components/dialog)、[MotionConfig](https://motion.dev/docs/react-motion-config)。
