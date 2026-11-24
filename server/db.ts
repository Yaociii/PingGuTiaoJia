import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  CharacterMarketStatRecord,
  DatabaseSchema,
  DetectLogRecord,
  GroupClaimRecord,
  GroupOrderItemRecord,
  GroupOrderRecord,
  GroupOrderStatus,
  InviteCodeRecord,
  MarketPriceCacheRecord,
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
    ['幻境物语', '紫晶魔女', '立牌', 2.45, 18],
    ['幻境物语', '苍蓝剑士', '立牌', 1.68, 15],
    ['幻境物语', '圣洁祭司', '立牌', 1.15, 11],
    ['幻境物语', '绯红骑士', '立牌', 0.92, 9],
    ['幻境物语', '精灵射手', '立牌', 0.54, 10],
    ['幻境物语', '翠影游侠', '立牌', 0.36, 8],
    ['排球少年', '孤爪研磨', '吧唧', 2.35, 24],
    ['排球少年', '黑尾铁朗', '吧唧', 1.78, 21],
    ['排球少年', '及川彻', '吧唧', 1.86, 19],
    ['排球少年', '日向翔阳', '吧唧', 1.22, 17],
    ['排球少年', '影山飞雄', '吧唧', 1.28, 16],
    ['排球少年', '月岛萤', '吧唧', 1.12, 14],
    ['排球少年', '夜久卫辅', '吧唧', 0.62, 12],
    ['排球少年', '犬冈走', '吧唧', 0.35, 11],
    ['蓝色监狱', '凪诚士郎', '吧唧', 2.25, 15],
    ['蓝色监狱', '糸师凛', '吧唧', 2.1, 14],
    ['蓝色监狱', '洁世一', '吧唧', 1.18, 12],
    ['蓝色监狱', '蜂乐回', '吧唧', 0.88, 9],
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

function generateShareCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += alphabet[bytes[i] % alphabet.length];
  }
  return code;
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
      this.data = {
        nextStatId: loaded.nextStatId ?? 1,
        nextContributionId: loaded.nextContributionId ?? 1,
        nextLogId: loaded.nextLogId ?? 1,
        invite_codes: loaded.invite_codes ?? {},
        character_market_stats: Array.isArray(loaded.character_market_stats)
          ? loaded.character_market_stats
          : [],
        market_price_cache: loaded.market_price_cache ?? {},
        market_contributions: Array.isArray(loaded.market_contributions)
          ? loaded.market_contributions
          : [],
        detect_logs: Array.isArray(loaded.detect_logs) ? loaded.detect_logs : [],
        group_orders: loaded.group_orders ?? {},
        group_order_items: Array.isArray(loaded.group_order_items)
          ? loaded.group_order_items
          : [],
        group_claims: Array.isArray(loaded.group_claims) ? loaded.group_claims : [],
      };
    } else {
      const seedStats = options?.seedMarketStats === false ? [] : createSeedStats();
      this.data = {
        nextStatId: seedStats.length + 1,
        nextContributionId: 1,
        nextLogId: 1,
        invite_codes: {},
        character_market_stats: seedStats,
        market_price_cache: {},
        market_contributions: [],
        detect_logs: [],
        group_orders: {},
        group_order_items: [],
        group_claims: [],
      };
    }

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

  private loadFromDisk(): Partial<DatabaseSchema> | null {
    if (!this.filePath) return null;
    try {
      if (!fs.existsSync(this.filePath)) return null;
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<DatabaseSchema>;
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

  public checkQuotaAvailable(
    code: string,
    now = new Date()
  ): { allowed: boolean; record: InviteCodeRecord | null } {
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

  // --- V2.0 Market Price Cache (default 48h TTL) ---
  public getCachedMarketPrice(
    cacheKey: string,
    now = new Date()
  ): MarketPriceCacheRecord | null {
    const rec = this.data.market_price_cache[cacheKey];
    if (!rec) return null;
    const exp = Date.parse(rec.expires_at);
    if (!Number.isFinite(exp) || exp <= now.getTime()) {
      delete this.data.market_price_cache[cacheKey];
      this.persist();
      return null;
    }
    return { ...rec, sources: rec.sources.map((s) => ({ ...s })) };
  }

  public setCachedMarketPrice(record: MarketPriceCacheRecord): void {
    this.data.market_price_cache[record.cache_key] = {
      ...record,
      sources: record.sources.map((s) => ({ ...s })),
    };
    // Keep cache bounded to 1000 entries
    const keys = Object.keys(this.data.market_price_cache);
    if (keys.length > 1000) {
      keys
        .sort(
          (a, b) =>
            Date.parse(this.data.market_price_cache[a].cached_at) -
            Date.parse(this.data.market_price_cache[b].cached_at)
        )
        .slice(0, keys.length - 1000)
        .forEach((k) => {
          delete this.data.market_price_cache[k];
        });
    }
    this.persist();
  }

  // --- Character Market Stats with 45-day half-life decay ---
  public matchCharacterWeight(
    ipName: string,
    label: string,
    category = '通用',
    options?: { now?: Date; allowStale?: boolean }
  ): CharacterMarketStatRecord | null {
    return matchMarketStat(this.data.character_market_stats, ipName, label, category, options);
  }

  public listMarketStats(filter?: {
    ipName?: string;
    category?: string;
  }): CharacterMarketStatRecord[] {
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
    return rows.sort(
      (a, b) => b.sample_count - a.sample_count || b.avg_weight_ratio - a.avg_weight_ratio
    );
  }

  public contributeMarketData(payload: {
    tokenCode: string;
    projectId: string;
    ipName: string;
    category: string;
    avgPrice: number;
    items: Array<{ label: string; final_price: number }>;
    now?: Date;
  }): { accepted: boolean; updated_count?: number; reason?: string } {
    const { tokenCode, projectId, ipName, category, avgPrice, items } = payload;
    const now = payload.now ?? new Date();

    const alreadyExists = this.data.market_contributions.some(
      (c) => c.token_code === tokenCode && c.project_id === projectId
    );
    if (alreadyExists) {
      return { accepted: false, reason: 'already_contributed' };
    }

    const cleanIp = ipName.trim();
    if (
      !cleanIp ||
      !Array.isArray(items) ||
      items.length < 2 ||
      !Number.isFinite(avgPrice) ||
      avgPrice <= 0
    ) {
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

    const cleanCategory = category?.trim() || '通用';
    const nowIso = now.toISOString();
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
          avgPrice,
          { lastUpdatedAt: existing.updated_at, now }
        );
        existing.avg_weight_ratio = next.avg_weight_ratio;
        existing.sample_count = next.sample_count;
        existing.updated_at = nowIso;
      } else {
        const next = computeUpdatedWeightRatio(1.0, 0, item.final_price, avgPrice, { now });
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
    if (this.data.detect_logs.length > 500) {
      this.data.detect_logs = this.data.detect_logs.slice(-500);
    }
    this.persist();
  }

  public getDetectLogs(): DetectLogRecord[] {
    return [...this.data.detect_logs];
  }

  // --- V2.0 Phase 3: Multi-User Live Group-Buy Orders (Atomic Anti-Oversell) ---
  public createGroupOrder(params: {
    title: string;
    ipName: string;
    annotatedImageDataUrl: string;
    items: Array<{
      sourceItemId?: string;
      label: string;
      price: number;
      prepaidPrice?: number;
      totalQty: number;
      tag?: string;
      box?: [number, number, number, number];
    }>;
    now?: Date;
  }): { order: GroupOrderRecord; items: GroupOrderItemRecord[] } {
    const nowIso = (params.now ?? new Date()).toISOString();
    let shareCode = generateShareCode();
    while (this.data.group_orders[shareCode]) {
      shareCode = generateShareCode();
    }
    const orderId = crypto.randomUUID();
    const ownerToken = crypto.randomBytes(24).toString('hex');

    const order: GroupOrderRecord = {
      id: orderId,
      share_code: shareCode,
      title: params.title.trim().slice(0, 64) || '在线谷子拼团',
      ip_name: params.ipName.trim().slice(0, 60) || '',
      owner_token: ownerToken,
      annotated_image_data_url: params.annotatedImageDataUrl,
      status: 'open',
      created_at: nowIso,
      updated_at: nowIso,
    };

    const createdItems: GroupOrderItemRecord[] = params.items
      .filter((it) => it.totalQty > 0)
      .map((it) => ({
        id: crypto.randomUUID(),
        order_id: orderId,
        source_item_id: it.sourceItemId,
        label: it.label.trim().slice(0, 32) || '谷子单品',
        price: Math.max(0, Math.round(it.price * 100) / 100),
        prepaid_price:
          it.prepaidPrice !== undefined && Number.isFinite(it.prepaidPrice)
            ? Math.max(0, Math.round(it.prepaidPrice * 100) / 100)
            : Math.max(0, Math.round(it.price * 100) / 100),
        total_qty: Math.max(1, Math.floor(it.totalQty)),
        claimed_qty: 0,
        tag: (it.tag || '').trim().slice(0, 12),
        box_json: it.box ? JSON.stringify(it.box) : undefined,
      }));

    this.data.group_orders[shareCode] = order;
    this.data.group_order_items.push(...createdItems);
    this.persist();

    return { order: { ...order }, items: createdItems.map((it) => ({ ...it })) };
  }

  public getGroupOrderByShareCode(shareCode: string): {
    order: GroupOrderRecord;
    items: GroupOrderItemRecord[];
    claims: GroupClaimRecord[];
  } | null {
    const code = shareCode.trim().toUpperCase();
    const order = this.data.group_orders[code];
    if (!order) return null;
    const items = this.data.group_order_items
      .filter((it) => it.order_id === order.id)
      .map((it) => ({ ...it }));
    const claims = this.data.group_claims
      .filter((c) => c.order_id === order.id && c.status === 'active')
      .map((c) => ({ ...c }));
    return { order: { ...order }, items, claims };
  }

  /**
   * 原子防超卖认领：严格在单线程同步临界区执行条件校验 claimed_qty + qty <= total_qty，
   * 库存不足时返回 conflict=true (HTTP 409)
   */
  public claimGroupOrderItem(params: {
    shareCode: string;
    itemId: string;
    buyerName: string;
    buyerContact: string;
    qty: number;
    now?: Date;
  }):
    | { ok: true; claim: GroupClaimRecord; item: GroupOrderItemRecord }
    | { ok: false; reason: 'not_found' | 'order_closed' | 'invalid_qty' | 'oversell_conflict'; remaining?: number } {
    const code = params.shareCode.trim().toUpperCase();
    const order = this.data.group_orders[code];
    if (!order) return { ok: false, reason: 'not_found' };
    if (order.status !== 'open') return { ok: false, reason: 'order_closed' };

    const qty = Math.floor(params.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      return { ok: false, reason: 'invalid_qty' };
    }

    const item = this.data.group_order_items.find(
      (it) => it.order_id === order.id && it.id === params.itemId
    );
    if (!item) return { ok: false, reason: 'not_found' };

    // Atomic conditional update: WHERE claimed_qty + qty <= total_qty
    if (item.claimed_qty + qty > item.total_qty) {
      return {
        ok: false,
        reason: 'oversell_conflict',
        remaining: Math.max(0, item.total_qty - item.claimed_qty),
      };
    }

    const nowIso = (params.now ?? new Date()).toISOString();
    item.claimed_qty += qty;
    order.updated_at = nowIso;

    const claim: GroupClaimRecord = {
      id: crypto.randomUUID(),
      order_id: order.id,
      item_id: item.id,
      buyer_name: params.buyerName.trim().slice(0, 32),
      buyer_contact: params.buyerContact.trim().slice(0, 48),
      qty,
      claim_token: crypto.randomBytes(16).toString('hex'),
      status: 'active',
      created_at: nowIso,
    };

    this.data.group_claims.push(claim);
    this.persist();

    return { ok: true, claim: { ...claim }, item: { ...item } };
  }

  public cancelGroupClaim(params: {
    shareCode: string;
    claimId: string;
    ownerToken?: string;
    claimToken?: string;
    now?: Date;
  }): { ok: true; claim: GroupClaimRecord; item: GroupOrderItemRecord } | { ok: false; reason: 'not_found' | 'forbidden' | 'already_cancelled' } {
    const code = params.shareCode.trim().toUpperCase();
    const order = this.data.group_orders[code];
    if (!order) return { ok: false, reason: 'not_found' };

    const claim = this.data.group_claims.find(
      (c) => c.order_id === order.id && c.id === params.claimId
    );
    if (!claim) return { ok: false, reason: 'not_found' };

    const isOwner = Boolean(params.ownerToken && params.ownerToken === order.owner_token);
    const isBuyerSelf = Boolean(params.claimToken && params.claimToken === claim.claim_token);
    if (!isOwner && !isBuyerSelf) {
      return { ok: false, reason: 'forbidden' };
    }
    if (claim.status === 'cancelled') {
      return { ok: false, reason: 'already_cancelled' };
    }

    const item = this.data.group_order_items.find(
      (it) => it.order_id === order.id && it.id === claim.item_id
    );
    if (!item) return { ok: false, reason: 'not_found' };

    claim.status = 'cancelled';
    item.claimed_qty = Math.max(0, item.claimed_qty - claim.qty);
    order.updated_at = (params.now ?? new Date()).toISOString();
    this.persist();

    return { ok: true, claim: { ...claim }, item: { ...item } };
  }

  public syncGroupOrderFromOrganizer(params: {
    shareCode: string;
    ownerToken: string;
    status?: GroupOrderStatus;
    annotatedImageDataUrl?: string;
    items?: Array<{
      sourceItemId?: string;
      label: string;
      price: number;
      prepaidPrice?: number;
      totalQty?: number;
      tag?: string;
    }>;
    now?: Date;
  }): { ok: true; order: GroupOrderRecord } | { ok: false; reason: 'not_found' | 'forbidden' } {
    const code = params.shareCode.trim().toUpperCase();
    const order = this.data.group_orders[code];
    if (!order) return { ok: false, reason: 'not_found' };
    if (!params.ownerToken || params.ownerToken !== order.owner_token) {
      return { ok: false, reason: 'forbidden' };
    }

    if (params.status && ['open', 'locked', 'settled'].includes(params.status)) {
      order.status = params.status;
    }
    if (params.annotatedImageDataUrl) {
      order.annotated_image_data_url = params.annotatedImageDataUrl;
    }

    if (Array.isArray(params.items)) {
      const orderItems = this.data.group_order_items.filter((it) => it.order_id === order.id);
      for (const patch of params.items) {
        const target =
          orderItems.find((it) => patch.sourceItemId && it.source_item_id === patch.sourceItemId) ||
          orderItems.find((it) => normalizeKey(it.label) === normalizeKey(patch.label));
        if (target) {
          target.price = Math.max(0, Math.round(patch.price * 100) / 100);
          if (patch.prepaidPrice !== undefined && Number.isFinite(patch.prepaidPrice)) {
            target.prepaid_price = Math.max(0, Math.round(patch.prepaidPrice * 100) / 100);
          }
          if (patch.totalQty !== undefined && Number.isFinite(patch.totalQty)) {
            target.total_qty = Math.max(target.claimed_qty, Math.floor(patch.totalQty));
          }
          if (patch.tag !== undefined) {
            target.tag = patch.tag.trim().slice(0, 12);
          }
        }
      }
    }

    order.updated_at = (params.now ?? new Date()).toISOString();
    this.persist();
    return { ok: true, order: { ...order } };
  }
}
