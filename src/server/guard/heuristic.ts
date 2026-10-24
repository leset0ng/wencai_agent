import { ALLOW } from './types'
import type { GuardProvider, GuardVerdict } from './types'

const WAIVER = '(?:无需|不用|不需要|不必|不要)(?:再|进行|任何|安全)?(?:确认|验证|密码|人脸|风控)'

/**
 * privilege 分两档（2026-10-23 收窄，原规则把"先不要确认""我不需要人脸识别"等正常用语整句拦截）：
 * - 拦截：明确要求跳过/绕过验证、声称风控已关闭，或"免确认 + 直接执行"的组合指令；
 * - 标记：单独的"不用确认""不需要验证"——用户输入照常处理但写审计，工具输出中仍会被屏蔽。
 * 降为标记是安全的：验证由确认链路强制执行，任何话术都绕不过去。
 * 组合指令后紧跟问句（"不用验证码，直接转账可以吗？"）是在询问规则，按 askedWeight 只标记。
 */
const PATTERNS: { category: string; re: RegExp; weight: number; askedWeight?: number }[] = [
  { category: 'override', re: /(忽略|无视|忘记|跳过|不要理会|别理会|不必理会).{0,8}(之前|先前|以前|以上|前面|所有|系统).{0,8}(规则|指令|指示|提示|设定|限制)/, weight: 0.9 },
  { category: 'override', re: /ignore(?:all)?(?:the)?(?:previous|prior|above)(?:instructions|rules)/i, weight: 0.9 },
  // 空白已去掉，dan 后不能紧跟字母，否则 "you are now a dancer" 会被当成越狱
  { category: 'role_hijack', re: /(你现在是|假装你是|扮演).{0,6}(管理员|开发者|系统|dan(?![a-z])|无限制)/i, weight: 0.8 },
  { category: 'role_hijack', re: /youarenow(?:an?)?(admin|developer|dan(?![a-z])|unrestricted)/i, weight: 0.8 },
  { category: 'prompt_leak', re: /(输出|显示|告诉我|打印).{0,6}(系统提示|systemprompt|初始指令)/i, weight: 0.7 },
  { category: 'privilege', re: /(?:跳过|绕过|省略|免除|免去)(?:任何|所有|全部|安全|的)*(?:确认|验证|密码|人脸|风控)/, weight: 0.85 },
  { category: 'privilege', re: new RegExp(`${WAIVER}.{0,6}(?:直接|立即|马上|立刻|就)(?:执行|转|付|扣|办|放行|完成|提交)`), weight: 0.85, askedWeight: 0.6 },
  { category: 'privilege', re: /(?:风控|安全验证|强验证|验证|确认)(?:功能|流程)?(?:已经?|已被|被)(?:关闭|停用|解除|豁免)/, weight: 0.85 },
  { category: 'privilege', re: new RegExp(WAIVER), weight: 0.6 },
  { category: 'fake_system', re: /(\[|【)\s*(system|系统|SYSTEM)\s*(\]|】)/, weight: 0.6 },
]

/** 匹配之后、同一句之内出现的问句标记 */
const ASKED = /^[^。！!；;]{0,12}?[?？吗么呢]/

/** 仅用于审核匹配，绝不改写用户请求或交易参数。兼容字符、不可见字符及空白不能拆开规则关键词。 */
export function normalizeGuardText(text: string): string {
  return text.normalize('NFKC').replace(/[\p{Cf}\p{White_Space}\u034f\ufe00-\ufe0f]/gu, '').toLowerCase()
}

/** 规则启发式：零依赖、零延迟，作为兜底与第一道筛查 */
export const heuristicGuard: GuardProvider = {
  name: 'heuristic',
  async check(text): Promise<GuardVerdict> {
    const normalized = normalizeGuardText(text)
    // 明确要求保留安全验证的正常表达不算“跳过验证”；其余攻击仍独立检查。
    const privilegeText = normalized.replace(/(?:不要|请勿|不能|不得|不允许|禁止|不可|不想)(?:再|直接|擅自)?(?:跳过|绕过|省略|取消)(?:任何|安全)?(?:确认|验证|密码|人脸|风控)/g, '')
    let score = 0
    const categories = new Set<string>()
    for (const p of PATTERNS) {
      const subject = p.category === 'privilege' ? privilegeText : normalized
      const match = p.re.exec(subject)
      if (match) {
        const asked = p.askedWeight !== undefined && ASKED.test(subject.slice(match.index + match[0].length))
        score = Math.max(score, asked ? p.askedWeight! : p.weight)
        categories.add(p.category)
      }
    }
    if (score === 0) return ALLOW('heuristic')
    return {
      verdict: score >= 0.8 ? 'block' : 'flag',
      score,
      categories: [...categories],
      provider: 'heuristic',
    }
  },
}
