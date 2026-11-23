import fs from 'node:fs';
import path from 'node:path';
import type {
  CharacterMarketStatRecord,
  DatabaseSchema,
  DetectLogRecord,
  InviteCodeRecord,
} from './types';
import {
  computeUpdatedWeightRatio,
  isPlaceholderLabel,
  matchMarketStat,
  normalizeKey,
} from './marketMatcher';

export function getUtcDateString(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function createSeedStats(): CharacterMarketStatRecord[] {
  const now = new Date().toISOString();
  const seeds: Array<[string, string, string, number, number]> = [
    // 幻境物语 (matching our flagship acrylic standee demo)
    ['幻境物语', '紫晶魔女', '立牌', 1.48, 18],
    ['幻境物语', '苍蓝剑士', '立牌', 1.24, 15],
    ['幻境物语', '圣洁祭司', '立牌', 1.12, 11],
    ['幻境物语', '绯红骑士', '立牌', 0.94, 9],
    ['幻境物语', '精灵射手', '立牌', 0.72, 10],
    ['幻境物语', '翠影游侠', '立牌', 0.56, 8],
    // 排球少年 (popular anime merch IP)
    ['排球少年', '孤爪研磨', '吧唧', 1.54, 24],
    ['排球少年', '黑尾铁朗', '吧唧', 1.38, 21],
    ['排球少年', '及川彻', '吧唧', 1.42, 19],
    ['排球少年', '日向翔阳', '吧唧', 1.15, 17],
    ['排球少年', '影山飞雄', '吧唧', 1.18, 16],
    ['排球少年', '月岛萤', '吧唧', 1.10, 14],
    ['排球少年', '夜久卫辅', '吧唧', 0.78, 12],
    ['排球少年', '犬冈走', '吧唧', 0.55, 11],
    // 蓝色监狱
    ['蓝色监狱', '凪诚士郎', '吧唧', 1.46, 15],
    ['蓝色监狱', '糸师凛', '吧唧', 1.40, 14],
    ['蓝色监狱', '洁世一', '吧唧', 1.16, 12],
    ['蓝色监狱', '蜂乐回', '吧唧', 0.92, 9],
  ];

  return seeds.map(([ip_name, character_name, category, avg_weight_ratio, sample_count], idx) => ({
    id: idx + 1,
    ip_name,
    character_name,
    normalized_key: normalizeKey(character_name),
    category,
    avg_weight_ratio,
    sample_count,
    updated_at: now,
  }));
}

export class GachaDatabase {
  private data: DatabaseSchema;
  private filePath: string | null;

  constructor(options?: {
    filePath?: string | null;
    defaultInviteCode?: string;
    defaultDailyLimit?: number;
    seedMarketStats?: boolean;
  }) {
    this.filePath = options?.filePath === undefined ? null : options.filePath;
    const defaultCode = options?.defaultInviteCode || process.env.DEFAULT_INVITE_CODE || 'dev-local-001';
    const defaultLimit =
      options?.defaultDailyLimit ||
      Math.max(1, Number.parseInt(process.env.DEFAULT_DAILY_LIMIT || '50', 10) || 50);

    const loaded = this.loadFromDisk();
    if (loaded) {
      this.data = loaded;
    } else {
      const seedStats = options?.seedMarketStats === false ? [] : createSeedStats();
      this.data = {
        nextStatId: seedStats.length + 1,
        nextContributionId: 1,
        nextLogId: 1,
        invite_codes: {},
        character_market_stats: seedStats,
        market_contributions: [],
        detect_logs: [],
      };
    }

    // Ensure default invite code exists
    if (!this.data.invite_codes[defaultCode]) {
      this.data.invite_codes[defaultCode] = {
        code: defaultCode,
        owner_note: '默认本地邀请码',
        daily_limit: defaultLimit,
        used_today: 0,
        last_reset_date: getUtcDateString(),
        is_active: true,
        created_at: new Date().toISOString(),
      };
    }

    this.persist();
  }

  private loadFromDisk(): DatabaseSchema | null {
    if (!this.filePath) return null;
    try {
      if (!fs.existsSync(this.filePath)) return null;
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as DatabaseSchema;
      if (!parsed || typeof parsed !== 'object' || !parsed.invite_codes) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      console.error('Failed to persist GachaDatabase:', err);
    }
  }

  public addInviteCode(record: InviteCodeRecord): void {
    this.data.invite_codes[record.code] = { ...record };
    this.persist();
  }

  /**
   * 校验邀请码并在跨 UTC 日期时自动归零 used_today
   */
  public verifyInviteCode(code: string | undefined, now = new Date()): InviteCodeRecord | null {
    if (!code || typeof code !== 'string') return null;
    const trimmed = code.trim();
    const record = this.data.invite_codes[trimmed];
    if (!record || !record.is_active) return null;

    const today = getUtcDateString(now);
    if (record.last_reset_date < today) {
      record.used_today = 0;
      record.last_reset_date = today;
      this.persist();
    }
    return record;
  }

  public checkQuotaAvailable(code: string, now = new Date()): { allowed: boolean; record: InviteCodeRecord | null } {
    const record = this.verifyInviteCode(code, now);
    if (!record) return { allowed: false, record: null };
    return { allowed: record.used_today < record.daily_limit, record };
  }

  public consumeQuota(code: string, now = new Date()): InviteCodeRecord | null {
    const record = this.verifyInviteCode(code, now);
    if (!record) return null;
    record.used_today += 1;
    this.persist();
    return record;
  }

  public matchCharacterWeight(
    ipName: string,
    label: string,
    category = '通用'
  ): CharacterMarketStatRecord | null {
    return matchMarketStat(this.data.character_market_stats, ipName, label, category);
  }

  public listMarketStats(filter?: { ipName?: string; category?: string }): CharacterMarketStatRecord[] {
    let rows = [...this.data.character_market_stats];
    if (filter?.ipName?.trim()) {
      const q = normalizeKey(filter.ipName);
      rows = rows.filter(
        (r) => normalizeKey(r.ip_name).includes(q) || normalizeKey(r.character_name).includes(q)
      );
    }
    if (filter?.category?.trim() && filter.category !== '全部') {
      rows = rows.filter((r) => r.category === filter.category);
    }
    return rows.sort((a, b) => b.sample_count - a.sample_count || b.avg_weight_ratio - a.avg_weight_ratio);
  }

  public contributeMarketData(payload: {
    tokenCode: string;
    projectId: string;
    ipName: string;
    category: string;
    avgPrice: number;
    items: Array<{ label: string; final_price: number }>;
  }): { accepted: boolean; updated_count?: number; reason?: string } {
    const { tokenCode, projectId, ipName, category, avgPrice, items } = payload;

    // 1. 幂等去重：检查 (token_code, project_id)
    const alreadyExists = this.data.market_contributions.some(
      (c) => c.token_code === tokenCode && c.project_id === projectId
    );
    if (alreadyExists) {
      return { accepted: false, reason: 'already_contributed' };
    }

    // 2. 有效性过滤
    const cleanIp = ipName.trim();
    if (!cleanIp || !Array.isArray(items) || items.length < 2 || !Number.isFinite(avgPrice) || avgPrice <= 0) {
      return { accepted: false, reason: 'no_price_variance' };
    }

    const validItems = items.filter(
      (it) =>
        it &&
        typeof it.label === 'string' &&
        !isPlaceholderLabel(it.label) &&
        Number.isFinite(it.final_price) &&
        it.final_price > 0
    );

    if (validItems.length < 2) {
      return { accepted: false, reason: 'no_price_variance' };
    }

    const firstPrice = validItems[0].final_price;
    const hasVariance = validItems.some((it) => Math.abs(it.final_price - firstPrice) > 0.009);
    if (!hasVariance) {
      return { accepted: false, reason: 'no_price_variance' };
    }

    // 3. 加权更新 character_market_stats
    const cleanCategory = category?.trim() || '通用';
    const nowIso = new Date().toISOString();
    let updatedCount = 0;

    for (const item of validItems) {
      const charName = item.label.trim().slice(0, 32);
      const normKey = normalizeKey(charName);
      if (!normKey) continue;

      const existing = this.data.character_market_stats.find(
        (s) =>
          normalizeKey(s.ip_name) === normalizeKey(cleanIp) &&
          s.normalized_key === normKey &&
          s.category === cleanCategory
      );

      if (existing) {
        const next = computeUpdatedWeightRatio(
          existing.avg_weight_ratio,
          existing.sample_count,
          item.final_price,
          avgPrice
        );
        existing.avg_weight_ratio = next.avg_weight_ratio;
        existing.sample_count = next.sample_count;
        existing.updated_at = nowIso;
      } else {
        const next = computeUpdatedWeightRatio(1.0, 0, item.final_price, avgPrice);
        this.data.character_market_stats.push({
          id: this.data.nextStatId++,
          ip_name: cleanIp,
          character_name: charName,
          normalized_key: normKey,
          category: cleanCategory,
          avg_weight_ratio: next.avg_weight_ratio,
          sample_count: next.sample_count,
          updated_at: nowIso,
        });
      }
      updatedCount++;
    }

    // 4. 写入幂等去重记录
    this.data.market_contributions.push({
      id: this.data.nextContributionId++,
      token_code: tokenCode,
      project_id: projectId,
      ip_name: cleanIp,
      item_count: updatedCount,
      created_at: nowIso,
    });

    this.persist();
    return { accepted: true, updated_count: updatedCount };
  }

  public addDetectLog(entry: Omit<DetectLogRecord, 'id' | 'created_at'>): void {
    this.data.detect_logs.push({
      ...entry,
      id: this.data.nextLogId++,
      created_at: new Date().toISOString(),
    });
    // Keep last 500 logs bounded
    if (this.data.detect_logs.length > 500) {
      this.data.detect_logs = this.data.detect_logs.slice(-500);
    }
    this.persist();
  }

  public getDetectLogs(): DetectLogRecord[] {
    return [...this.data.detect_logs];
  }
}
