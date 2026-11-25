import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  CharacterMarketStatRecord,
  DatabaseSchema,
  DetectLogRecord,
  GroupClaimRecord,
  GroupOrderItemRecord,
  GroupOrderRecord,
  InviteCodeRecord,
  MarketContributionRecord,
  MarketPriceCacheRecord,
} from './types';

function isJsonLegacyFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return false;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(64);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      const head = buf.subarray(0, bytesRead).toString('utf-8').trimStart();
      return head.startsWith('{');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function findFileInsideDir(dirPath: string): string | null {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isFile() && isJsonLegacyFile(full)) {
        return full;
      }
      if (entry.isDirectory()) {
        const nested = findFileInsideDir(full);
        if (nested) return nested;
      }
    }
  } catch {
    // ignore unreadable dirs
  }
  return null;
}

function resolveCandidateFile(candidatePath: string): { filePath: string; cleanupRoot?: string } | null {
  try {
    if (!fs.existsSync(candidatePath)) return null;
    const stat = fs.statSync(candidatePath);
    if (stat.isFile()) {
      return isJsonLegacyFile(candidatePath) ? { filePath: candidatePath } : null;
    }
    if (stat.isDirectory()) {
      const nested = findFileInsideDir(candidatePath);
      return nested ? { filePath: nested, cleanupRoot: candidatePath } : null;
    }
  } catch {
    // ignore inaccessible path
  }
  return null;
}

function findLegacyJsonSource(): { filePath: string; cleanupRoot?: string } | null {
  const cwd = process.cwd();
  const candidates: string[] = [];

  // 1. process.env.DATABASE_PATH
  const envDbPath = process.env.DATABASE_PATH?.trim();
  if (envDbPath) {
    const resolvedEnv = path.resolve(cwd, envDbPath);
    if (!resolvedEnv.endsWith('.db')) {
      candidates.push(resolvedEnv);
    }
  }

  // 2. ./data/gacha-db.json
  candidates.push(path.resolve(cwd, './data/gacha-db.json'));

  // 3. Illegal filename in repo root (contains ':', 'Coding', or named '_D_')
  try {
    for (const name of fs.readdirSync(cwd)) {
      if (name.includes(':') || name.includes('Coding') || name === '_D_') {
        candidates.push(path.join(cwd, name));
      }
    }
  } catch {
    // ignore readdir failure
  }

  // 4. Zip-extracted variant ./_D_/Coding/谷子/database_
  candidates.push(path.resolve(cwd, './_D_/Coding/谷子/database_'));

  const seen = new Set<string>();
  for (const cand of candidates) {
    if (seen.has(cand)) continue;
    seen.add(cand);
    const found = resolveCandidateFile(cand);
    if (found) return found;
  }
  return null;
}

function countTable(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as
    | { cnt: number | bigint }
    | undefined;
  return Number(row?.cnt ?? 0);
}

function removeEmptyParentDirs(startDir: string, stopAt: string): void {
  let current = path.resolve(startDir);
  const root = path.resolve(stopAt);
  while (current !== root && current.startsWith(root + path.sep)) {
    try {
      if (fs.readdirSync(current).length === 0) {
        fs.rmdirSync(current);
        current = path.dirname(current);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

export function migrateLegacyJsonIfNeeded(db: DatabaseSync): {
  migrated: boolean;
  sourcePath?: string;
  counts?: Record<string, number>;
  error?: string;
} {
  try {
    // Idempotency check
    const already = db
      .prepare("SELECT value FROM meta WHERE key = 'migrated_from'")
      .get() as { value: string } | undefined;
    if (already) {
      return { migrated: false };
    }

    const found = findLegacyJsonSource();
    if (!found) {
      return { migrated: false };
    }

    const rawContent = fs.readFileSync(found.filePath, 'utf-8');
    const parsed = JSON.parse(rawContent) as Partial<DatabaseSchema>;
    if (!parsed || typeof parsed !== 'object' || !parsed.invite_codes) {
      return {
        migrated: false,
        sourcePath: found.filePath,
        error: '旧数据文件不是有效的 GachaDatabase JSON 结构。',
      };
    }

    const inviteCodes: InviteCodeRecord[] = Object.values(parsed.invite_codes ?? {});
    const marketStats: CharacterMarketStatRecord[] = Array.isArray(parsed.character_market_stats)
      ? parsed.character_market_stats
      : [];
    const priceCache: MarketPriceCacheRecord[] = Object.values(parsed.market_price_cache ?? {});
    const contributions: MarketContributionRecord[] = Array.isArray(parsed.market_contributions)
      ? parsed.market_contributions
      : [];
    const detectLogs: DetectLogRecord[] = Array.isArray(parsed.detect_logs)
      ? parsed.detect_logs
      : [];
    const groupOrders: GroupOrderRecord[] = Object.values(parsed.group_orders ?? {});
    const groupOrderItems: GroupOrderItemRecord[] = Array.isArray(parsed.group_order_items)
      ? parsed.group_order_items
      : [];
    const groupClaims: GroupClaimRecord[] = Array.isArray(parsed.group_claims)
      ? parsed.group_claims
      : [];

    const expectedCounts: Record<string, number> = {
      invite_codes: inviteCodes.length,
      character_market_stats: marketStats.length,
      market_price_cache: priceCache.length,
      market_contributions: contributions.length,
      detect_logs: detectLogs.length,
      group_orders: groupOrders.length,
      group_order_items: groupOrderItems.length,
      group_claims: groupClaims.length,
    };

    db.exec('BEGIN IMMEDIATE');
    try {
      // Clear constructor-seeded rows on a fresh database so imported rows match source 1:1
      const hasExistingUserData =
        countTable(db, 'group_orders') > 0 ||
        countTable(db, 'detect_logs') > 0 ||
        countTable(db, 'market_contributions') > 0;
      if (!hasExistingUserData) {
        db.exec(`
          DELETE FROM group_claims;
          DELETE FROM group_order_items;
          DELETE FROM group_orders;
          DELETE FROM detect_logs;
          DELETE FROM market_contributions;
          DELETE FROM market_price_cache;
          DELETE FROM character_market_stats;
          DELETE FROM invite_codes;
        `);
      }

      const insInvite = db.prepare(`
        INSERT OR REPLACE INTO invite_codes
          (code, owner_note, daily_limit, used_today, last_reset_date, is_active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of inviteCodes) {
        insInvite.run(
          r.code,
          r.owner_note ?? '',
          r.daily_limit,
          r.used_today,
          r.last_reset_date,
          r.is_active ? 1 : 0,
          r.created_at
        );
      }

      const insStat = db.prepare(`
        INSERT OR REPLACE INTO character_market_stats
          (id, ip_name, character_name, normalized_key, category, avg_weight_ratio, sample_count, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of marketStats) {
        insStat.run(
          r.id,
          r.ip_name,
          r.character_name,
          r.normalized_key,
          r.category,
          r.avg_weight_ratio,
          r.sample_count ?? 0,
          r.updated_at
        );
      }

      const insCache = db.prepare(`
        INSERT OR REPLACE INTO market_price_cache
          (cache_key, ip_name, normalized_char, series_key, item_type,
           market_price_median, market_price_range, sample_count, sources,
           pricing_tier, freshness, query_used, cached_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of priceCache) {
        insCache.run(
          r.cache_key,
          r.ip_name,
          r.normalized_char,
          r.series_key ?? '',
          r.item_type ?? '通用',
          r.market_price_median === null || r.market_price_median === undefined
            ? null
            : r.market_price_median,
          r.market_price_range ? JSON.stringify(r.market_price_range) : null,
          r.sample_count ?? 0,
          JSON.stringify(r.sources ?? []),
          r.pricing_tier,
          r.freshness,
          r.query_used ?? '',
          r.cached_at,
          r.expires_at
        );
      }

      const insContrib = db.prepare(`
        INSERT OR REPLACE INTO market_contributions
          (id, token_code, project_id, ip_name, item_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const r of contributions) {
        insContrib.run(
          r.id,
          r.token_code,
          r.project_id ?? '',
          r.ip_name,
          r.item_count ?? 0,
          r.created_at
        );
      }

      const insLog = db.prepare(`
        INSERT OR REPLACE INTO detect_logs
          (id, token_code, provider, model, detected_count, latency_ms, status, error_msg, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of detectLogs) {
        insLog.run(
          r.id,
          r.token_code ?? '',
          r.provider,
          r.model,
          r.detected_count ?? 0,
          r.latency_ms ?? 0,
          r.status,
          r.error_msg ?? null,
          r.created_at
        );
      }

      const insOrder = db.prepare(`
        INSERT OR REPLACE INTO group_orders
          (id, share_code, title, ip_name, owner_token, annotated_image_data_url, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of groupOrders) {
        insOrder.run(
          r.id,
          r.share_code,
          r.title,
          r.ip_name,
          r.owner_token,
          r.annotated_image_data_url ?? '',
          r.status,
          r.created_at,
          r.updated_at
        );
      }

      const insItem = db.prepare(`
        INSERT OR REPLACE INTO group_order_items
          (id, order_id, source_item_id, label, price, prepaid_price, total_qty, claimed_qty, tag, box_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of groupOrderItems) {
        insItem.run(
          r.id,
          r.order_id,
          r.source_item_id ?? null,
          r.label,
          r.price,
          r.prepaid_price === undefined ? null : r.prepaid_price,
          r.total_qty,
          r.claimed_qty ?? 0,
          r.tag ?? '',
          r.box_json ?? null
        );
      }

      const insClaim = db.prepare(`
        INSERT OR REPLACE INTO group_claims
          (id, order_id, item_id, buyer_name, buyer_contact, qty, claim_token, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of groupClaims) {
        insClaim.run(
          r.id,
          r.order_id,
          r.item_id,
          r.buyer_name,
          r.buyer_contact,
          r.qty,
          r.claim_token,
          r.status ?? 'active',
          r.created_at
        );
      }

      // Verify per-table row counts inside the transaction before committing
      const actualCounts: Record<string, number> = {};
      const tableNames = Object.keys(expectedCounts);
      let allMatched = true;
      const reportLines: string[] = [
        '[migration] 逐表校验结果:',
        '| 表名 | 源条数 | 库条数 | 是否一致 |',
        '| --- | ---: | ---: | :---: |',
      ];

      for (const table of tableNames) {
        const actual = countTable(db, table);
        actualCounts[table] = actual;
        const ok = actual === expectedCounts[table];
        if (!ok) allMatched = false;
        reportLines.push(`| ${table} | ${expectedCounts[table]} | ${actual} | ${ok ? '一致' : '不一致'} |`);
      }

      // Additional field-level spot checks
      for (const r of inviteCodes) {
        const row = db
          .prepare('SELECT daily_limit FROM invite_codes WHERE code = ?')
          .get(r.code) as { daily_limit: number | bigint } | undefined;
        if (!row || Number(row.daily_limit) !== r.daily_limit) {
          allMatched = false;
          reportLines.push(`[migration] 校验失败: invite_codes(${r.code}).daily_limit 不一致`);
        }
      }

      for (const r of groupOrderItems) {
        const row = db
          .prepare('SELECT claimed_qty FROM group_order_items WHERE id = ?')
          .get(r.id) as { claimed_qty: number | bigint } | undefined;
        if (!row || Number(row.claimed_qty) !== (r.claimed_qty ?? 0)) {
          allMatched = false;
          reportLines.push(`[migration] 校验失败: group_order_items(${r.id}).claimed_qty 不一致`);
        }
      }

      for (const r of groupOrders) {
        const row = db
          .prepare('SELECT LENGTH(annotated_image_data_url) AS len FROM group_orders WHERE id = ?')
          .get(r.id) as { len: number | bigint } | undefined;
        const expectedLen = (r.annotated_image_data_url ?? '').length;
        if (!row || Number(row.len) !== expectedLen) {
          allMatched = false;
          reportLines.push(
            `[migration] 校验失败: group_orders(${r.share_code}).annotated_image_data_url 长度不一致 (${row?.len} !== ${expectedLen})`
          );
        }
      }

      console.log(reportLines.join('\n'));

      if (!allMatched) {
        db.exec('ROLLBACK');
        const errMsg = '迁移校验未通过，已回滚事务并保留旧数据文件。';
        console.error(`[migration] ${errMsg}`);
        return { migrated: false, sourcePath: found.filePath, counts: actualCounts, error: errMsg };
      }

      // Backup raw JSON to gitignored data/legacy-json-backup.json before removing legacy file
      const backupDir = path.resolve(process.cwd(), 'data');
      fs.mkdirSync(backupDir, { recursive: true });
      const backupPath = path.join(backupDir, 'legacy-json-backup.json');
      fs.writeFileSync(backupPath, rawContent, 'utf-8');

      // Record migration metadata inside the same transaction
      const nowIso = new Date().toISOString();
      const insMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
      insMeta.run('migrated_from', found.filePath);
      insMeta.run('migrated_at', nowIso);

      db.exec('COMMIT');

      // Delete legacy source file / directory only after COMMIT and backup succeed
      if (found.cleanupRoot && path.basename(found.cleanupRoot) === '_D_') {
        fs.rmSync(found.cleanupRoot, { recursive: true, force: true });
        console.log(`已删除旧数据文件: ${found.cleanupRoot}`);
      } else {
        fs.rmSync(found.filePath, { force: true });
        removeEmptyParentDirs(path.dirname(found.filePath), process.cwd());
        console.log(`已删除旧数据文件: ${found.filePath}`);
      }

      // Also clean up _D_ folder if legacy file lived inside it
      const dDir = path.resolve(process.cwd(), '_D_');
      if (fs.existsSync(dDir)) {
        fs.rmSync(dDir, { recursive: true, force: true });
      }

      return {
        migrated: true,
        sourcePath: found.filePath,
        counts: actualCounts,
      };
    } catch (txErr) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore rollback error if transaction already closed
      }
      throw txErr;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[migration] 旧 JSON 数据迁移失败，已保留旧文件并以现有库继续启动: ${msg}`);
    return { migrated: false, error: msg };
  }
}
