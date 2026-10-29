/**
 * 行级 diff（M3）：朴素 LCS（最长公共子序列）——O(n·m) DP，
 * 对代码文件行数（通常 < 数百行）绰绰有余，且实现可讲清原理。
 * 产出Unified语义的三态行：ctx（上下文）/ del（删）/ add（增）。
 */
export interface DiffLine {
  type: 'ctx' | 'del' | 'add';
  text: string;
}

export function splitLines(s: string): string[] {
  return s.replace(/\r\n/g, '\n').split('\n');
}

export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const n = a.length, m = b.length;

  // dp[i][j] = a[i:] 与 b[j:] 的 LCS 长度（倒序填表便于回溯）
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j]
        ? dp[i + 1]![j + 1]! + 1
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  // 回溯：相同行 → ctx；否则优先删旧行（保持删除先于新增的阅读习惯）
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: 'ctx', text: a[i]! }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { out.push({ type: 'del', text: a[i]! }); i++; }
    else { out.push({ type: 'add', text: b[j]! }); j++; }
  }
  while (i < n) { out.push({ type: 'del', text: a[i]! }); i++; }
  while (j < m) { out.push({ type: 'add', text: b[j]! }); j++; }
  return out;
}

/** 摘要：±N 行（工具卡头部徽标用） */
export function diffStats(lines: DiffLine[]): { add: number; del: number } {
  let add = 0, del = 0;
  for (const l of lines) {
    if (l.type === 'add') add++;
    else if (l.type === 'del') del++;
  }
  return { add, del };
}
