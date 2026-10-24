/**
 * 业务时间统一按北京时间（UTC+8）计算，不依赖服务器或浏览器的本地时区。
 *
 * 项目里有十余处手写 `8 * 3600_000` 的偏移计算，新代码请改用这里的函数；
 * 旧代码在重构时逐步迁移。本模块不含 I/O，前后端均可使用。
 *
 * 注意：这里只做"真实时刻 ↔ 北京时间日历"的换算，不负责"现在是几点"。
 * 业务上的"现在"可能是仿真时钟，仍需从服务端时钟取得后传入。
 */

export const BEIJING_OFFSET_MS = 8 * 3600_000
export const DAY_MS = 86_400_000

/** 把真实时刻平移到北京时间，返回的 Date 只能用 getUTC* 或 toISOString 读取日历字段 */
const shifted = (date: Date) => new Date(date.getTime() + BEIJING_OFFSET_MS)

/** 北京时间日期：YYYY-MM-DD */
export const beijingDate = (date: Date) => shifted(date).toISOString().slice(0, 10)

/** 北京时间月份：YYYY-MM */
export const beijingMonth = (date: Date) => shifted(date).toISOString().slice(0, 7)

/** 北京时间日期与时刻：YYYY-MM-DD HH:mm:ss */
export const beijingDateTime = (date: Date) => shifted(date).toISOString().slice(0, 19).replace('T', ' ')

/** 该时刻所在北京时间自然日的零点（真实时刻） */
export const beijingDayStart = (date: Date) =>
  new Date(Math.floor((date.getTime() + BEIJING_OFFSET_MS) / DAY_MS) * DAY_MS - BEIJING_OFFSET_MS)

/** 该时刻所在北京时间自然日的范围：[start, end) */
export function beijingDayRange(date: Date) {
  const start = beijingDayStart(date)
  return { start, end: new Date(start.getTime() + DAY_MS) }
}
