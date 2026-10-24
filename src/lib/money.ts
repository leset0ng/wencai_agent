/**
 * 金额换算与展示。数据库一律存整数"分"，这里集中处理"分 ↔ 元"和人民币格式。
 *
 * 项目里有十余份各自实现的 yuan / fmt / money，取整与负数写法不完全一致；
 * 新代码请改用这里的函数，旧代码在重构时逐步迁移。本模块不含 I/O，前后端均可使用。
 */

/** 分 → 元（数值），先四舍五入到整分 */
export const centsToYuan = (cents: number) => Math.round(cents) / 100

/** 元 → 分（整数）。用于把用户输入或模型参数中的元转为存储单位 */
export const yuanToCents = (yuan: number) => Math.round(yuan * 100)

const grouped = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const currency = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2 })

/** 分 → "1,234.56"（不带货币符号，千分位，两位小数） */
export const formatCents = (cents: number) => grouped.format(cents / 100)

/** 分 → "¥1,234.56"；负数为 "-¥1,234.56" */
export const formatYuan = (cents: number) => currency.format(cents / 100)
