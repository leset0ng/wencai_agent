# UI 交互组件结构图

依据当前本地源码整理，日期：2026-10-16。图中的层级表示界面组织与职责；虚线表示复用、调用或状态通知，不表示所有组件都直接互相导入。

## 1. 整体结构

```mermaid
flowchart TB
  Root["RootDocument / UIProvider"]
  Root --> Theme["ThemeProvider<br/>浅色 / 深色 / 跟随系统"]
  Root --> Motion["MotionConfig<br/>统一动画 / 减弱动态效果"]
  Root --> Security["SecureOperationProvider<br/>全局独立安全页调度"]
  Root --> Routes["页面入口 · TanStack Router"]

  subgraph Pages["页面与业务组件"]
    direction LR
    Auth["AuthPage<br/>登录 / 注册 / 手机验证码"]
    Home["BankingHome<br/>导航 / 页面状态 / Agent 浮窗"]
    Settings["SettingsPage<br/>主题 / 每卡密码 / 设备 / 渠道"]
    Admin["Admin Home / Workspace<br/>业务模拟与管理后台"]
  end
  Routes --> Auth
  Routes --> Home
  Routes --> Settings
  Routes --> Admin

  subgraph Banking["银行主界面"]
    direction LR
    Dashboard["首页<br/>DesktopDashboard / 手机首页"]
    Accounts["账户<br/>DesktopAccounts / AccountCarousel"]
    Life["生活<br/>LifeMarket"]
    Profile["我的<br/>资料 / 设置 / 退出登录"]
    Dialogs["业务弹层<br/>PaymentCenter / CardServices<br/>CardApplication / TaskCenter"]
  end
  Home --> Dashboard
  Home --> Accounts
  Home --> Life
  Home --> Profile
  Home --> Dialogs

  subgraph Agent["Agent 对话与生成式交互"]
    direction LR
    Chat["ChatView<br/>消息 / 输入 / 停止生成 / 回执"]
    Progress["AgentProgress<br/>阶段文字向上切换"]
    Tool["ToolPart<br/>工具结果与确认单分发"]
    Group["AgentInteractionGroup<br/>选择分组 / 去重 / 暂存"]
    Renderer["GenUI catalog + registry<br/>受限组件目录与渲染"]
    CardDisplay["AgentCardDisplay<br/>只读卡片浏览 · 无操作按钮"]
    Questionnaire["AgentQuestionnaire<br/>逐题选择 · 最终统一提交"]
  end
  Home --> Chat
  Chat --> Progress
  Chat --> Tool
  Chat --> Group
  Tool --> Renderer
  Tool --> CardDisplay
  Tool --> Questionnaire

  subgraph Commerce["生活业务组件"]
    direction LR
    Checkout["LifeCheckout<br/>付款卡 / 数量 / 收件人<br/>立即送出 / 预约送达 / 续费授权"]
    Orders["LifeOrders<br/>订单 / 物流 / 退货退款"]
    Subs["LifeSubscriptions<br/>有效期 / 下次扣费 / 取消"]
  end
  Life --> Checkout
  Life --> Orders
  Life --> Subs

  Shared["共用交互组件<br/>BankCard · CardNumber · Carousel<br/>AgentCardPicker · AgentChoiceList · AgentSelectableTable<br/>AgentSelectionConfirm · ConfirmCard<br/>Sheet · FinancialReport · Animated Charts"]
  Accounts -.-> Shared
  Dialogs -.-> Shared
  Group -.-> Shared
  Renderer -.-> Shared
  Commerce -.-> Shared

  Approval["PaymentApproval / DashboardConfirmation<br/>共用 ConfirmCard"]
  Dialogs -.-> Approval
  Commerce -.-> Approval
  Tool -.-> Approval
  Approval -.-> Security
  Security --> SecureSheet["SecureSheet → 同源 iframe<br/>/secure-operation 独立页面"]
  SecureSheet --> Factors["CardPasswordInput / CardPasswordKeypad<br/>StrongVerification：短信 / 指纹 / 人脸"]
  Factors --> API["受控服务端 API<br/>确认 / 安全验证 / 业务执行 / 回执"]
  API -. "结果通知与查询刷新" .-> Chat
  API -. "结果刷新" .-> Home

  Base["基础组件层<br/>Base UI：Button / Input / Select / Tabs / Dialog / Checkbox<br/>Carousel：Embla · 动画：Motion · 图表：自绘 SVG + Motion<br/>数据状态：TanStack Query"]
  Shared -.-> Base
  Theme -.-> Base
  Motion -.-> Base
```

## 2. Agent 的选择与确认流程

```mermaid
flowchart TD
  Intent["用户输入自然语言需求"] --> Stream["ChatView 请求 /api/chat<br/>流式接收文字、工具结果、交互模板"]
  Stream --> Dispatch["ToolPart / GenUI registry<br/>映射到已有组件"]
  Dispatch --> NeedChoice{"是否需要选择对象？"}
  NeedChoice -- "需要" --> Choose["银行卡轮播 / 对象列表 / 可选择表格"]
  NeedChoice -- "无需选择或仅一个对象" --> Fixed["对象已确定<br/>省略选择或显示灰色确定状态"]
  Choose --> Draft["SelectionDraft 暂存选择<br/>选择按钮不发送消息"]
  Draft --> Confirm["AgentSelectionConfirm<br/>显示当前汇总 · 确认 / 取消"]
  Fixed --> Confirm
  Confirm -- "取消" --> Choose
  Confirm -- "确认" --> Template["交互模板 + 已选对象 + 当前业务参数<br/>生成完整、可恢复上下文的消息"]
  Template --> Send["发送给 Agent<br/>不是简单重复历史用户输入"]
  Send --> Missing{"参数是否齐全？"}
  Missing -- "否" --> Ask["继续询问缺失信息"]
  Ask --> Stream
  Missing -- "是：查询" --> Read["查询工具 → 数据与图表"]
  Missing -- "是：写操作" --> Pending["服务端生成受保护的确认单"]
  Pending --> Card["ConfirmCard<br/>展示服务端核对信息"]
  Card --> Secure["独立安全页面<br/>完成策略要求的验证"]
  Secure -- "验证成功" --> Execute["服务端重新判定风险<br/>执行并返回真实回执"]
  Secure -- "关闭 / 中止 / 失败" --> Keep["未执行；保留原交互<br/>允许重新选择或重新办理"]
  Keep --> Confirm
  Execute --> Receipt["confirmation-notices<br/>刷新账户与业务数据<br/>Agent 查询执行回执，不重复执行"]
```

两种“确认”职责不同：`AgentSelectionConfirm` 负责把业务选择提交给 Agent；`ConfirmCard` 负责核对服务端确认单并调用安全页。发送消息不等于授权交易。已完成或过期的确认单不能再次执行，可通过原卡片的“重新办理”入口生成新确认单。

交互消息相关文件：`src/components/chat/interaction-message.ts`、`selection-groups.ts`、`interaction-layout.ts`、`src/lib/agent-interaction-template.ts`。固定文案模板约束模型生成的字段；批量转账使用 `BatchTransferView` 保留每笔对象、金额及选择。

## 3. 原生业务与安全组件复用

```mermaid
flowchart LR
  Payment["转账 / 收款人<br/>PaymentCenter"] --> Prepare["/api/payments<br/>准备业务确认单"]
  Cards["申请 / 备注 / 冻结 / 挂失 / 额度<br/>CardApplication / CardServices"] --> Prepare
  Shopping["购买 / 退款 / 订阅 / 取消<br/>LifeCommercePanels"] --> Prepare
  Prepare --> Approval["PaymentApproval → ConfirmCard"]
  Agent["Agent 写操作结果<br/>ToolPart"] --> Confirm["ConfirmCard"]
  Approval --> Provider["useSecureOperation<br/>SecureOperationProvider"]
  Confirm --> Provider
  Number["CardNumber<br/>点击眼睛查看完整卡号"] --> Provider
  Password["CardPasswordAction<br/>设置或修改此卡密码"] --> Provider
  Provider --> Doc["SecureSheet /secure-operation<br/>同源 iframe 独立文档"]
  Doc --> API["/api/secure-operation<br/>创建 / 验证 / 读取结果 / 关闭"]
  API --> Bank["服务端权限、确认与业务服务<br/>非 UI 决定能否执行"]
  Bank --> Result["仅返回结果<br/>密码不传给 Agent 或父页面"]
  Result --> Refresh["刷新 TanStack Query 缓存"]
  Result --> Notice["成功确认通知 → Agent 回执核对"]
```

安全页根据服务端返回的要求渲染所需验证。常规支付提供密码或可用替代方式；红色等级要求强验证；单笔超过3000元或收款账户异常的转账要求密码加指纹/人脸。指纹、人脸当前为显式演示验证，不代表真实生物识别。

## 4. 源码入口索引

| 职责 | 主要文件 |
| --- | --- |
| 应用外壳与全局 Provider | `src/routes/__root.tsx`、`src/components/ui/provider.tsx` |
| 主界面与响应式布局 | `src/components/banking/BankingHome.tsx`、`DesktopDashboard.tsx`、`DesktopAccounts.tsx` |
| 登录、注册与安全设置 | `src/components/banking/AuthPage.tsx`、`src/routes/login.tsx`、`register.tsx`、`settings.tsx` |
| 卡片与账单联动 | `src/components/banking/AccountCarousel.tsx`、`src/components/ui/BankCard.tsx`、`CardNumber.tsx` |
| 转账与卡片管理 | `src/components/banking/PaymentCenter.tsx`、`CardServices.tsx`、`DashboardConfirmation.tsx` |
| 生活商城与订阅 | `src/components/banking/LifeMarket.tsx`、`LifeCommercePanels.tsx`、`LifeProductArt.tsx` |
| 任务与自动授权展示 | `src/components/banking/TaskCenter.tsx`、`MandateList.tsx` |
| 对话、进度与工具呈现 | `src/components/chat/ChatView.tsx`、`ToolPart.tsx`、`AgentProgress.tsx`、`BatchTransferView.tsx` |
| 共用选择与确认 | `src/components/chat/AgentInteraction.tsx`、`ConfirmCard.tsx` |
| 只读银行卡与逐题问卷 | `src/components/chat/AgentCardDisplay.tsx`、`AgentQuestionnaire.tsx`、`display-purpose.ts`、`src/lib/questionnaire.ts` |
| 生成式组件白名单 | `src/genui/catalog.ts`、`registry.tsx` |
| 独立安全页及验证组件 | `src/components/ui/SecureOperation.tsx`、`SecureSheet.tsx`、`CardPasswordInput.tsx`、`StrongVerification.tsx`、`src/routes/secure-operation.tsx` |
| 基础组件、主题及动画 | `src/components/ui/`、`src/components/ThemeToggle.tsx`、`src/lib/theme.ts` |
| 查询、API 与回执通知 | `src/lib/queries.ts`、`src/lib/confirmation-notices.ts`、`src/routes/api/` |
| 管理后台 | `src/components/admin/Home.tsx`、`Workspace.tsx`、`ActionDialog.tsx`、`views/` |

首页、账户页的桌面布局与手机布局部分分开实现；银行卡、轮播、图表、Agent 选择、银行确认单及安全验证是跨页面复用的主要边界。生活订单与会员权益的配送模拟属于服务端业务逻辑，不由 UI 自行生成交易结果。
