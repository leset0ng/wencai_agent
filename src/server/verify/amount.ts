/** 金额比对统一用"保留两位小数的字符串"。独立成文件，避免 numbers.ts 与 transactions.ts 互相引用。 */
export function normalizeAmount(n: number): string {
  return (Math.round(n * 100) / 100).toString()
}
