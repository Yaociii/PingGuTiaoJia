import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { GachaDatabase } from './db';
import { createApiRouter } from './app';
import type { VlmProvider } from './vlmProvider';

// Minimal valid 1x1 PNG bytes
const TINY_PNG_BUFFER = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex'
);

async function startTestServer(options?: {
  dailyLimit?: number;
  vlmRawOutput?: string;
  getNow?: () => Date;
}) {
  const db = new GachaDatabase({
    filePath: null,
    defaultInviteCode: 'test-code-001',
    defaultDailyLimit: options?.dailyLimit ?? 2,
    seedMarketStats: true,
  });

  const mockVlm: VlmProvider = {
    providerName: 'mock',
    modelName: 'mock-vlm-1',
    isConfigured: () => true,
    async detectGoods() {
      return (
        options?.vlmRawOutput ??
        `\`\`\`json
        {
          "ip_name": "排球少年",
          "items": [
            { "label": "研磨", "box": [100, 100, 450, 350], "weight": 1.1, },
            { "label": "新角色甲", "box": [100, 400, 450, 650], "weight": 0.9, }
          ],
        }
        \`\`\``
      );
    },
  };

  const app = express();
  app.use('/api/v1', createApiRouter({ db, vlmProvider: mockVlm, getNow: options?.getNow }));

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    db,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('API health, auth 401, dirty JSON + market_db fusion, quota 429, and UTC cross-day reset', async () => {
  let currentNow = new Date('2026-11-23T10:00:00Z');
  const srv = await startTestServer({ dailyLimit: 1, getNow: () => currentNow });

  try {
    // 1. Health check
    const healthRes = await fetch(`${srv.baseUrl}/api/v1/health`);
    assert.equal(healthRes.status, 200);
    const health = (await healthRes.json()) as { status: string; version: string };
    assert.equal(health.status, 'ok');

    // 2. Invalid token -> 401
    const badForm = new FormData();
    badForm.append('image', new Blob([TINY_PNG_BUFFER], { type: 'image/png' }), 'test.png');
    const unauthRes = await fetch(`${srv.baseUrl}/api/v1/detect`, {
      method: 'POST',
      headers: { 'X-Access-Token': 'wrong-token' },
      body: badForm,
    });
    assert.equal(unauthRes.status, 401);

    // 3. Corrupted image -> 400 without consuming quota
    const corruptForm = new FormData();
    corruptForm.append('image', new Blob([Buffer.from('not-an-image-at-all')], { type: 'image/png' }), 'bad.png');
    const corruptRes = await fetch(`${srv.baseUrl}/api/v1/detect`, {
      method: 'POST',
      headers: { 'X-Access-Token': 'test-code-001' },
      body: corruptForm,
    });
    assert.equal(corruptRes.status, 400);

    // 4. Valid detect -> 200, fuses "研磨" with seeded "孤爪研磨" market_db weight (1.54), leaves "新角色甲" as vlm_guess
    const okForm = new FormData();
    okForm.append('image', new Blob([TINY_PNG_BUFFER], { type: 'image/png' }), 'goods.png');
    okForm.append('category', '吧唧');
    const okRes = await fetch(`${srv.baseUrl}/api/v1/detect`, {
      method: 'POST',
      headers: { 'X-Access-Token': 'test-code-001' },
      body: okForm,
    });
    assert.equal(okRes.status, 200);
    const detected = (await okRes.json()) as {
      ip_name: string;
      items: Array<{ label: string; weight: number; weight_source: string; x: number; y: number }>;
    };
    assert.equal(detected.ip_name, '排球少年');
    assert.equal(detected.items.length, 2);
    assert.equal(detected.items[0].weight_source, 'market_db');
    assert.equal(detected.items[0].weight, 1.54);
    assert.equal(detected.items[1].weight_source, 'vlm_guess');
    assert.equal(detected.items[1].weight, 0.9);

    // 5. Daily quota exceeded -> 429
    const limitForm = new FormData();
    limitForm.append('image', new Blob([TINY_PNG_BUFFER], { type: 'image/png' }), 'goods2.png');
    const limitRes = await fetch(`${srv.baseUrl}/api/v1/detect`, {
      method: 'POST',
      headers: { 'X-Access-Token': 'test-code-001' },
      body: limitForm,
    });
    assert.equal(limitRes.status, 429);

    // 6. Next UTC day -> quota resets automatically!
    currentNow = new Date('2026-11-24T00:05:00Z');
    const nextDayForm = new FormData();
    nextDayForm.append('image', new Blob([TINY_PNG_BUFFER], { type: 'image/png' }), 'goods3.png');
    const nextDayRes = await fetch(`${srv.baseUrl}/api/v1/detect`, {
      method: 'POST',
      headers: { 'X-Access-Token': 'test-code-001' },
      body: nextDayForm,
    });
    assert.equal(nextDayRes.status, 200);
  } finally {
    await srv.close();
  }
});

test('POST /api/v1/market/contribute enforces project_id idempotency and price variance filtering', async () => {
  const srv = await startTestServer();
  try {
    // 1. Flat equal prices -> rejected with no_price_variance
    const flatRes = await fetch(`${srv.baseUrl}/api/v1/market/contribute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Access-Token': 'test-code-001',
      },
      body: JSON.stringify({
        project_id: 'proj-flat-1',
        ip_name: '测试作品',
        category: '吧唧',
        avg_price: 30,
        items: [
          { label: '角色甲', final_price: 30 },
          { label: '角色乙', final_price: 30 },
        ],
      }),
    });
    assert.equal(flatRes.status, 200);
    const flatData = (await flatRes.json()) as { accepted: boolean; reason?: string };
    assert.equal(flatData.accepted, false);
    assert.equal(flatData.reason, 'no_price_variance');

    // 2. Valid varied contribution -> accepted
    const validPayload = {
      project_id: 'proj-unique-1',
      ip_name: '排球少年',
      category: '吧唧',
      avg_price: 30,
      items: [
        { label: '孤爪研磨', final_price: 45 },
        { label: '犬冈走', final_price: 15 },
      ],
    };
    const firstRes = await fetch(`${srv.baseUrl}/api/v1/market/contribute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Access-Token': 'test-code-001',
      },
      body: JSON.stringify(validPayload),
    });
    assert.equal(firstRes.status, 200);
    const firstData = (await firstRes.json()) as { accepted: boolean; updated_count?: number };
    assert.equal(firstData.accepted, true);
    assert.equal(firstData.updated_count, 2);

    const afterFirst = srv.db.matchCharacterWeight('排球少年', '孤爪研磨', '吧唧');
    assert.ok(afterFirst);
    const countAfterFirst = afterFirst.sample_count;

    // 3. Duplicate project_id -> already_contributed, sample_count unchanged
    const dupRes = await fetch(`${srv.baseUrl}/api/v1/market/contribute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Access-Token': 'test-code-001',
      },
      body: JSON.stringify(validPayload),
    });
    assert.equal(dupRes.status, 200);
    const dupData = (await dupRes.json()) as { accepted: boolean; reason?: string };
    assert.equal(dupData.accepted, false);
    assert.equal(dupData.reason, 'already_contributed');

    const afterDup = srv.db.matchCharacterWeight('排球少年', '孤爪研磨', '吧唧');
    assert.equal(afterDup?.sample_count, countAfterFirst);
  } finally {
    await srv.close();
  }
});
