import type { CharacterMarketStatRecord } from './types';

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

function round3(val: number): number {
  return Math.round(val * 1000) / 1000;
}

/**
 * 规范化角色/IP 键：全半角统一、去空白与标点、转小写
 */
export function normalizeKey(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_·•・,，.。/\\()（）【】[\]「」『』:：!?！？'"`~@#%^&*+=<>|]/g, '')
    .trim();
}

/**
 * 判断是否是无意义的默认占位角色名（如纯数字、"谷子1"、"单品2"、"角色A" 等）
 */
export function isPlaceholderLabel(label: string): boolean {
  const key = normalizeKey(label);
  if (!key) return true;
  if (/^\d+$/.test(key)) return true;
  if (/^(谷子|单品|商品|角色|款式|item|pin|good)\d*[a-z]?$/i.test(key)) return true;
  return false;
}

/**
 * 类似 Python difflib.SequenceMatcher.ratio() 的序列相似度（2 * LCS / (lenA + lenB)）
 */
export function sequenceSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  return (2 * dp[m][n]) / (m + n);
}

/**
 * 在行情库中查找同 IP 角色的历史权重：
 * 1. 优先匹配同 category，未命中再回退 "通用"
 * 2. 先精确匹配 normalized_key，再做包含关系或 SequenceMatcher >= 0.78 模糊匹配
 * 3. 仅当 sample_count >= 3 时覆盖 VLM 权重
 */
export function matchMarketStat(
  stats: CharacterMarketStatRecord[],
  ipName: string,
  label: string,
  category = '通用'
): CharacterMarketStatRecord | null {
  const normIp = normalizeKey(ipName);
  const normLabel = normalizeKey(label);
  if (!normIp || !normLabel) return null;

  const sameIp = stats.filter((s) => normalizeKey(s.ip_name) === normIp);
  if (sameIp.length === 0) return null;

  const findInSubset = (subset: CharacterMarketStatRecord[]): CharacterMarketStatRecord | null => {
    // 1. Exact key match
    const exact = subset.find((s) => s.normalized_key === normLabel);
    if (exact) return exact;

    // 2. Fuzzy or containment match (e.g. "研磨" matching "孤爪研磨")
    let best: CharacterMarketStatRecord | null = null;
    let bestScore = 0;
    for (const candidate of subset) {
      const ck = candidate.normalized_key;
      const isContainment =
        normLabel.length >= 2 &&
        ck.length >= 2 &&
        (ck.includes(normLabel) || normLabel.includes(ck));
      const sim = sequenceSimilarity(normLabel, ck);
      const effectiveScore = isContainment ? Math.max(sim, 0.85) : sim;

      if (effectiveScore >= 0.78 && effectiveScore > bestScore) {
        bestScore = effectiveScore;
        best = candidate;
      }
    }
    return best;
  };

  const catSubset = sameIp.filter((s) => s.category === category);
  const hitCat = findInSubset(catSubset);
  if (hitCat && hitCat.sample_count >= 3) return hitCat;

  if (category !== '通用') {
    const generalSubset = sameIp.filter((s) => s.category === '通用');
    const hitGeneral = findInSubset(generalSubset);
    if (hitGeneral && hitGeneral.sample_count >= 3) return hitGeneral;
  }

  return null;
}

/**
 * 行情权重加权更新：
 * - sample_count < 20：累计均值 (old * n + ratio) / (n + 1)
 * - sample_count >= 20：指数移动平均 0.9 * old + 0.1 * ratio
 */
export function computeUpdatedWeightRatio(
  oldRatio: number,
  oldSampleCount: number,
  finalPrice: number,
  avgPrice: number
): { avg_weight_ratio: number; sample_count: number } {
  const ratio = clamp(finalPrice / avgPrice, 0.2, 3.0);
  if (oldSampleCount <= 0) {
    return { avg_weight_ratio: round3(ratio), sample_count: 1 };
  }
  const updated =
    oldSampleCount < 20
      ? (oldRatio * oldSampleCount + ratio) / (oldSampleCount + 1)
      : 0.9 * oldRatio + 0.1 * ratio;
  return {
    avg_weight_ratio: round3(clamp(updated, 0.2, 3.0)),
    sample_count: oldSampleCount + 1,
  };
}
