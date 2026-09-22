/**
 * 版本比较工具（semver 语义：支持 v 前缀、pre-release 后缀、build metadata 忽略）
 * 返回: 1 = a > b, 0 = a == b, -1 = a < b
 *
 * 历史缺陷（2026-09-22 修）：旧实现把每段 `Number()` 后经 `|| 0` 兜底，带
 * pre-release 的段（如 `1.0.26-2427fix.1` 的 `26-2427fix`）变 NaN 被洗成 0，
 * 导致 `1.0.25 > 1.0.26-2427fix.1` 误判「有更新」。现按 semver 规则比较：
 * 主版本逐段数字比（缺段当 0，兼容 1.0 vs 1.0.0）；主版本相等时无
 * pre-release 者更大；pre-release 逐标识符比较（纯数字按数值、且小于
 * 字母数字标识符，字母数字按 ASCII）。非数字主段容错当 0（与旧行为一致）。
 */

interface ParsedVersion {
  core: number[];
  prerelease: string[] | null;
}

function parseVersion(version: string): ParsedVersion {
  let raw = version.trim().replace(/^v/, "");
  // build metadata（+...）不参与比较
  const plusIdx = raw.indexOf("+");
  if (plusIdx >= 0) raw = raw.slice(0, plusIdx);

  const dashIdx = raw.indexOf("-");
  const coreRaw = dashIdx >= 0 ? raw.slice(0, dashIdx) : raw;
  const prereleaseRaw = dashIdx >= 0 ? raw.slice(dashIdx + 1) : null;

  // 非数字段容错为 0（保留旧实现兜底行为；合法输入不应出现）
  const core = coreRaw.split(".").map((seg) => {
    const n = Number(seg);
    return Number.isFinite(n) ? n : 0;
  });
  const prerelease =
    prereleaseRaw !== null && prereleaseRaw.length > 0
      ? prereleaseRaw.split(".")
      : null;

  return { core, prerelease };
}

function compareCore(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const aPart = a[i] ?? 0;
    const bPart = b[i] ?? 0;
    if (aPart > bPart) return 1;
    if (aPart < bPart) return -1;
  }
  return 0;
}

function isNumericIdentifier(id: string): boolean {
  return /^\d+$/.test(id);
}

/** semver 11/12：纯数字标识符恒小于字母数字标识符；同为数字按数值比，否则 ASCII 比 */
function comparePrerelease(a: string[] | null, b: string[] | null): number {
  if (a === null && b === null) return 0;
  // 无 pre-release（正式版）> 有 pre-release
  if (a === null) return 1;
  if (b === null) return -1;

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const aId = a[i];
    const bId = b[i];
    // 较短的标识符列表更小（1.0.0-alpha < 1.0.0-alpha.1）
    if (aId === undefined) return -1;
    if (bId === undefined) return 1;

    const aNum = isNumericIdentifier(aId);
    const bNum = isNumericIdentifier(bId);
    if (aNum && bNum) {
      const diff = Number(aId) - Number(bId);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1;
    } else {
      if (aId < bId) return -1;
      if (aId > bId) return 1;
    }
  }
  return 0;
}

export function compareVersions(a: string, b: string): number {
  const parsedA = parseVersion(a);
  const parsedB = parseVersion(b);

  const coreResult = compareCore(parsedA.core, parsedB.core);
  if (coreResult !== 0) return coreResult;

  return comparePrerelease(parsedA.prerelease, parsedB.prerelease);
}
