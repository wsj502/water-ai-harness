/**
 * 权限引擎：消费设置页原型里那张「审批规则表」。
 *
 * 规则：风险级决定默认策略，会话级授权（「本会话总是允许」）按 key 记忆。
 * key 粒度：普通工具 = 工具名；shell = 命令前缀（如 "npm run test:*"）。
 */

export type Risk = 'low' | 'medium' | 'high';
export type Decision = 'allow' | 'ask' | 'deny';

export interface PermissionRule {
  /** 工具名，支持 * 通配（如 "shell"、"mcp__*"） */
  tool: string;
  /** 可选：参数前缀匹配（仅 shell 类有意义），如 "npm run test:" */
  argPrefix?: string;
  decision: Decision;
}

export class PermissionEngine {
  /** 会话级授权：key 形如 "shell:npm run test:" 或 "edit" */
  private sessionGrants = new Set<string>();
  private rules: PermissionRule[] = [];

  constructor(private opts: {
    /** 低风险工具自动放行（设置页开关） */
    autoAllowLowRisk?: boolean;
  } = {}) {}

  setRules(rules: PermissionRule[]): void { this.rules = rules; }

  grantSession(key: string): void { this.sessionGrants.add(key); }

  /** 判断一次调用是否需要审批 */
  check(toolName: string, risk: Risk, argSummary: string): Decision {
    const grantKey = `${toolName}:${argSummary}`;
    if (this.sessionGrants.has(grantKey) || this.sessionGrants.has(toolName)) return 'allow';

    // 显式规则优先（从上往下，命中即返回）
    for (const r of this.rules) {
      if (r.tool !== '*' && r.tool !== toolName) continue;
      if (r.argPrefix && !argSummary.startsWith(r.argPrefix)) continue;
      return r.decision;
    }

    // 默认策略：低风险看开关，中高风险一律询问
    if (risk === 'low' && (this.opts.autoAllowLowRisk ?? true)) return 'allow';
    return 'ask';
  }
}
