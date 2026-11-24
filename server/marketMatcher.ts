import type { CharacterMarketStatRecord } from './types';

export const MARKET_WEIGHT_MIN = 0.1;
export const MARKET_WEIGHT_MAX = 10.0;
export const MARKET_DECAY_HALF_LIFE_DAYS = 45;
export const MARKET_STALE_DAYS = 90;

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
 * V2.0 计算距今天数（非负）
 */
export function calcElapsedDays(updatedAtIso: string | undefined, now = new Date()): number {
  if (!updatedAtIso) return 0;
  const ts = Date.parse(updatedAtIso);
  if (!Number.isFinite(ts)) return 0;
  const diffMs = Math.max(0, now.getTime() - ts);
  return diffMs / (24 * 60 * 60 * 1000);
}

/**
 * V2.0 指数时间衰减系数：decay = 0.5 ^ (Δdays / halfLifeDays)，默认半衰期 45 天
 */
export function computeTimeDecayFactor(
  updatedAtIso: string | undefined,
  now = new Date(),
  halfLifeDays = MARKET_DECAY_HALF_LIFE_DAYS
): number {
  const days = calcElapsedDays(updatedAtIso, now);
  if (days <= 0 || halfLifeDays <= 0) return 1;
  return Math.pow(0.5, days / halfLifeDays);
}

/**
 * 判断本地历史行情是否超过 90 天未更新（自动降权，不再强制覆盖外部新比价）
 */
export function isMarketStatStale(updatedAtIso: string | undefined, now = new Date()): boolean {
  return calcElapsedDays(updatedAtIso, now) > MARKET_STALE_DAYS;
}

/**
 * 在行情库中查找同 IP 角色的历史权重：
 * 1. 优先匹配同 category，未命中再回退 "通用"
 * 2. 先精确匹配 normalized_key，再做包含关系或 SequenceMatcher >= 0.78 模糊匹配
 * 3. V2.0 引入时间衰减校验：超过 90 天未更新或衰减后有效样本不足时默认不强覆盖（allowStale=true 时可兜底）
 */
export function matchMarketStat(
  stats: CharacterMarketStatRecord[],
  ipName: string,
  label: string,
  category = '通用',
  options?: { now?: Date; allowStale?: boolean }
): CharacterMarketStatRecord | null {
  const normIp = normalizeKey(ipName);
  const normLabel = normalizeKey(label);
  if (!normIp || !normLabel) return null;

  const now = options?.now ?? new Date();
  const allowStale = options?.allowStale ?? false;

  const sameIp = stats.filter((s) => normalizeKey(s.ip_name) === normIp);
  if (sameIp.length === 0) return null;

  const isEligible = (s: CharacterMarketStatRecord): boolean => {
    if (s.sample_count < 3) return false;
    if (!allowStale && isMarketStatStale(s.updated_at, now)) {
      return false;
    }
    return true;
  };

  const findInSubset = (subset: CharacterMarketStatRecord[]): CharacterMarketStatRecord | null => {
    const exact = subset.find((s) => s.normalized_key === normLabel);
    if (exact && isEligible(exact)) return exact;

    let best: CharacterMarketStatRecord | null = null;
    let bestScore = 0;
    for (const candidate of subset) {
      if (!isEligible(candidate)) continue;
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
  if (hitCat) return hitCat;

  if (category !== '通用') {
    const generalSubset = sameIp.filter((s) => s.category === '通用');
    const hitGeneral = findInSubset(generalSubset);
    if (hitGeneral) return hitGeneral;
  }

  return null;
}

/**
 * V2.0 行情权重加权更新（支持 [0.1, 10.0] 宽幅权重 + 45天半衰期指数时间衰减）：
 * - 先对历史有效样本量执行衰减：effective_n = oldSampleCount * 0.5^(Δdays / 45)
 * - effective_n < 20：加权均值 (oldRatio * effective_n + ratio) / (effective_n + 1)
 * - effective_n >= 20：指数移动平均 0.9 * oldRatio + 0.1 * ratio
 */
export function computeUpdatedWeightRatio(
  oldRatio: number,
  oldSampleCount: number,
  finalPrice: number,
  avgPrice: number,
  options?: { lastUpdatedAt?: string; now?: Date; halfLifeDays?: number }
): { avg_weight_ratio: number; sample_count: number; effective_n: number } {
  const ratio = clamp(finalPrice / avgPrice, MARKET_WEIGHT_MIN, MARKET_WEIGHT_MAX);
  if (oldSampleCount <= 0) {
    return { avg_weight_ratio: round3(ratio), sample_count: 1, effective_n: 0 };
  }

  const decay = options?.lastUpdatedAt
    ? computeTimeDecayFactor(options.lastUpdatedAt, options.now ?? new Date(), options.halfLifeDays)
    : 1.0;
  const effectiveN = oldSampleCount * decay;

  const updated =
    effectiveN < 20
      ? (oldRatio * effectiveN + ratio) / (effectiveN + 1)
      : 0.9 * oldRatio + 0.1 * ratio;

  return {
    avg_weight_ratio: round3(clamp(updated, MARKET_WEIGHT_MIN, MARKET_WEIGHT_MAX)),
    sample_count: oldSampleCount + 1,
    effective_n: round3(effectiveN),
  };
}
