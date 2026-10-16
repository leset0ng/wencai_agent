# Agent 账单查询口径

2026-10-15 修复：原 list_transactions 将 UTC ISO 截为日期，而账户页使用北京时间，凌晨交易会在 Agent 中错一天。查询接口此前只有近 N 天及最多50笔限制，没有单日筛选和银行卡归属，容易将未返回的数据误认为不存在。

- list_transactions 新增 date，或 startDate/endDate（两端包含），按北京时间零点转换为数据库查询边界。先筛选日期、账户与分类，再分页；days 使用与首页相同的仿真时钟。
- 返回结构为 transaction_history：query、timeZone、matchedCount、returnedCount、hasMore、transactions。明细保留 id/amount/category/counterparty/memo，新增 date/time/occurredAt、accountId/accountName、cardId/cardLast4/cardKind；不返回完整卡号或密码。翻页使用 offset/limit。生成视图的明细引用路径改为 /list_transactions/transactions。
- 所有账单不限定分类；明确要求转账时才筛选转账。无转账只说明该分类无记录，不能声称没有消费，也不自动展示相邻日期。历史交易卡片归属从流水绑定账户取得，与当前 UI 选中卡无关。
- 回复核验对含明确完整日期与金额的明细增加联合检查：日期、金额和显式尾号须能匹配同一条可信工具流水；独立有出处的数字不能随意拼接。日期范围/汇总不作为单笔明细校验。本检查不等同于通用语义事实校验。
- analyze_spending 的逐笔日期也统一为北京时间。

复核现有演示库：2026-09-07 08:37 的19.22元是购物消费，工资卡尾号8823；该日无转账。截图提到的256.79元与81.65元转账确实存在，分别为北京时间9月4日15:49和9月10日01:25，均属于工资卡8823。后一笔的UTC时间为9月9日17:25，原回答因此错一天。

验证：新增指定日边界、跨月分页、用户隔离、卡片归属、无效日期及回复字段联合校验测试；真实模型实测指定日转账、所有账单、区间转账及“这两笔是哪张卡”的追问。全部使用隔离数据库，无支付执行。证据在 .scratch/transaction-query-model-proof.json、transaction-query-followup-proof.json。
