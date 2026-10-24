/**
 * 只格式化本次改动过的文件（相对 HEAD 的已修改、已暂存、新增未跟踪文件）。
 *
 *   pnpm format:changed           格式化改动过的文件
 *   pnpm format:changed --check   只检查，不写入；有未格式化文件时退出码为 1
 *
 * 全量格式化会与其他开发者产生大面积冲突，须约定时间、用单独提交完成（见 docs/HANDOFF.md §6）。
 * 在此之前请只用本脚本，不要运行 `prettier --write .`。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as prettier from 'prettier'

const root = fileURLToPath(new URL('../', import.meta.url))
const check = process.argv.includes('--check')

const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

const candidates = [
  ...new Set([
    ...git('diff', '--name-only', '--diff-filter=ACMR', 'HEAD'),
    ...git('ls-files', '--others', '--exclude-standard'),
  ]),
]

const ignorePath = path.join(root, '.prettierignore')
const pending = []
for (const file of candidates) {
  const absolute = path.join(root, file)
  if (!fs.existsSync(absolute)) continue
  const info = await prettier.getFileInfo(absolute, { ignorePath })
  if (info.ignored || !info.inferredParser) continue
  const source = fs.readFileSync(absolute, 'utf8')
  const options = { ...(await prettier.resolveConfig(absolute)), filepath: absolute }
  if (await prettier.check(source, options)) continue
  pending.push(file)
  if (!check) fs.writeFileSync(absolute, await prettier.format(source, options))
}

if (!pending.length) console.log('改动过的文件均已符合格式。')
else if (check) {
  console.log(`以下 ${pending.length} 个改动过的文件尚未格式化：\n${pending.map((f) => `  ${f}`).join('\n')}`)
  process.exitCode = 1
} else console.log(`已格式化 ${pending.length} 个文件：\n${pending.map((f) => `  ${f}`).join('\n')}`)
