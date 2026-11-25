import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { GachaDatabase } from './db';
import { createApiRouter } from './app';
import { registerGroupH5Route } from './groupH5Page';
import {
  PriceLookupService,
  type BasePriceSource,
  type PriceLookupQuery,
} from './priceLookup';
import { MultiProtocolVlmProvider, type CustomAiConfig, type VlmProvider } from './vlmProvider';

// Minimal valid 1x1 PNG bytes
const TINY_PNG_BUFFER = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex'
);

async function startTestServer(options?: {
  dailyLimit?: number;
  vlmRawOutput?: string;
  autoPriceRawOutput?: string;
  vlmProvider?: VlmProvider;
  priceLookupService?: PriceLookupService;
  getNow?: () => Date;
}) {
  const db = new GachaDatabase({
    filePath: null,
    defaultInviteCode: 'test-code-001',
    defaultDailyLimit: options?.dailyLimit ?? 2,
    seedMarketStats: true,
  });

  const mockVlm: VlmProvider = options?.vlmProvider ?? {
    providerName: 'mock',
    modelName: 'mock-vlm-1',
    isConfigured: () => true,
    async detectGoods(params: { customConfig?: CustomAiConfig }) {
      const label =
        params.customConfig && params.customConfig.protocol !== 'server_default'
          ? `${params.customConfig.protocol}:${params.customConfig.model || 'custom'}`
          : 'mock:mock-vlm-1';
      return {
        providerUsed: label,
        rawText:
          options?.vlmRawOutput ??
          `\`\`\`json
          {
            "ip_name": "排球少年",
            "items": [
              { "label": "研磨", "box": [100, 100, 450, 350], "weight": 1.1, },
              { "label": "新角色甲", "box": [100, 400, 450, 650], "weight": 0.9, }
            ],
          }
          \`\`\``,
      };
    },
    async autoPriceGoods(params: { customConfig?: CustomAiConfig }) {
      const label =
        params.customConfig && params.customConfig.protocol !== 'server_default'
          ? `${params.customConfig.protocol}:${params.customConfig.model || 'custom'}`
          : 'mock:mock-vlm-1';
      return {
        providerUsed: label,
        rawText:
          options?.autoPriceRawOutput ??
          `{
            "ip_name": "排球少年",
            "summary": "热角上浮，冷门下调促成团",
            "items": [
              { "id": "i1", "label": "孤爪研磨", "weight": 1.2, "tag": "热烫", "reason": "核心人气" },
              { "id": "i2", "label": "未知角色乙", "weight": 0.7, "tag": "捆物", "reason": "冷门调低" }
            ]
          }`,
      };
    },
    async testConnection(params: { customConfig?: CustomAiConfig }) {
      return {
        providerUsed:
          params.customConfig && params.customConfig.protocol !== 'server_default'
            ? `${params.customConfig.protocol}:${params.customConfig.model || 'custom'}`
            : 'mock:mock-vlm-1',
        replyPreview: '正常',
        latencyMs: 12,
      };
    },
  };

  // Hermetic default in tests unless custom priceLookupService is passed
  const priceLookupService =
    options?.priceLookupService ?? new PriceLookupService({ sources: [] });

  const app = express();
  registerGroupH5Route(app, db);
  app.use(
    '/api/v1',
    createApiRouter({
      db,
      vlmProvider: mockVlm,
      priceLookupService,
      getNow: options?.getNow,
    })
  );

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
  const dayOne = new Date();
  let currentNow = new Date(
    Date.UTC(dayOne.getUTCFullYear(), dayOne.getUTCMonth(), dayOne.getUTCDate(), 10, 0, 0)
  );
  const srv = await startTestServer({ dailyLimit: 1, getNow: () => currentNow });

  try {
    // 1. Health check
    const healthRes = await fetch(`${srv.baseUrl}/api/v1/health`);
    assert.equal(healthRes.status, 200);
    const health = (await healthRes.json()) as {
      status: string;
      version: string;
      supported_protocols: string[];
    };
    assert.equal(health.status, 'ok');
    assert.equal(health.version, '2.0.0');
    assert.ok(health.supported_protocols.includes('openai_compatible'));
    assert.ok(health.supported_protocols.includes('anthropic'));

    // 2. Invalid token -> 401 for server_default
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
    corruptForm.append(
      'image',
      new Blob([Buffer.from('not-an-image-at-all')], { type: 'image/png' }),
      'bad.png'
    );
    const corruptRes = await fetch(`${srv.baseUrl}/api/v1/detect`, {
      method: 'POST',
      headers: { 'X-Access-Token': 'test-code-001' },
      body: corruptForm,
    });
    assert.equal(corruptRes.status, 400);

    // 4. Valid detect -> 200, fuses "研磨" with seeded "孤爪研磨" market_db wide weight (2.35)
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
      items: Array<{ label: string; weight: number; weight_source: string }>;
    };
    assert.equal(detected.ip_name, '排球少年');
    assert.equal(detected.items.length, 2);
    assert.equal(detected.items[0].weight_source, 'market_db');
    assert.equal(detected.items[0].weight, 2.35);
    assert.equal(detected.items[1].weight_source, 'vlm_guess');
    assert.equal(detected.items[1].weight, 0.9);

    // 5. Daily quota exceeded -> 429 for server_default
    const limitForm = new FormData();
    limitForm.append('image', new Blob([TINY_PNG_BUFFER], { type: 'image/png' }), 'goods2.png');
    const limitRes = await fetch(`${srv.baseUrl}/api/v1/detect`, {
      method: 'POST',
      headers: { 'X-Access-Token': 'test-code-001' },
      body: limitForm,
    });
    assert.equal(limitRes.status, 429);

    // 5b. BYOK user with own API Key succeeds even when server default quota is exhausted
    const byokForm = new FormData();
    byokForm.append('image', new Blob([TINY_PNG_BUFFER], { type: 'image/png' }), 'goods-byok.png');
    const byokRes = await fetch(`${srv.baseUrl}/api/v1/detect`, {
      method: 'POST',
      headers: {
        'X-AI-Protocol': 'openai_compatible',
        'X-AI-Api-Key': 'sk-user-test-key',
        'X-AI-Base-Url': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        'X-AI-Model': 'qwen2.5-vl-72b-instruct',
      },
      body: byokForm,
    });
    assert.equal(byokRes.status, 200);
    const byokData = (await byokRes.json()) as { provider_used: string };
    assert.equal(byokData.provider_used, 'openai_compatible:qwen2.5-vl-72b-instruct');

    // 6. Next UTC day -> server default quota resets automatically!
    currentNow = new Date(currentNow.getTime() + 24 * 60 * 60 * 1000);
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

test('MultiProtocolVlmProvider routes OpenAI, Gemini, and Anthropic protocols prioritizing user config over env vars', async () => {
  const capturedCalls: Array<{
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }> = [];

  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    capturedCalls.push({ url, headers, body });

    if (url.includes('/chat/completions')) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '{"ip_name":"排球少年","summary":"OpenAI测试","items":[{"id":"i1","label":"孤爪研磨","weight":1.5,"tag":"热烫","reason":"热"}]}',
              },
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (url.includes(':generateContent')) {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: '正常' }],
              },
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (url.includes('/v1/messages')) {
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '正常' }],
        }),
        { status: 200 }
      );
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const provider = new MultiProtocolVlmProvider('gemini-4-hydrogen', mockFetch);
  const srv = await startTestServer({ vlmProvider: provider });

  try {
    // 1. SSRF attempt on /api/v1/ai/test is blocked with 400
    const ssrfRes = await fetch(`${srv.baseUrl}/api/v1/ai/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AI-Protocol': 'openai_compatible',
        'X-AI-Api-Key': 'sk-test',
        'X-AI-Base-Url': 'http://127.0.0.1:8000/v1',
      },
      body: '{}',
    });
    assert.equal(ssrfRes.status, 400);

    // 2. OpenAI-compatible /api/v1/auto-price prioritizes user Base URL, Key & Model and fuses market_db
    const autoPriceRes = await fetch(`${srv.baseUrl}/api/v1/auto-price`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AI-Protocol': 'openai_compatible',
        'X-AI-Api-Key': 'sk-custom-qwen-key',
        'X-AI-Base-Url': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        'X-AI-Model': 'qwen2.5-vl-72b-instruct',
      },
      body: JSON.stringify({
        ip_name: '排球少年',
        category: '吧唧',
        target_total: 200,
        items: [
          { id: 'i1', label: '孤爪研磨', locked: false, price: 30, quantity: 1, weight: 1, tag: '' },
          { id: 'i2', label: '陌生角色', locked: false, price: 30, quantity: 1, weight: 1, tag: '' },
        ],
      }),
    });
    assert.equal(autoPriceRes.status, 200);
    const apData = (await autoPriceRes.json()) as {
      provider_used: string;
      items: Array<{ id: string; weight: number; weight_source: string; tag: string }>;
    };
    assert.equal(apData.provider_used, 'openai:qwen2.5-vl-72b-instruct');
    assert.equal(apData.items[0].weight_source, 'market_db');
    assert.equal(apData.items[0].weight, 2.35);
    assert.equal(
      capturedCalls[0].url,
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
    );
    assert.equal(capturedCalls[0].headers.Authorization, 'Bearer sk-custom-qwen-key');
    assert.equal(capturedCalls[0].body.model, 'qwen2.5-vl-72b-instruct');

    // 3. Gemini native protocol with custom relay & user key
    const geminiTestRes = await fetch(`${srv.baseUrl}/api/v1/ai/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AI-Protocol': 'gemini',
        'X-AI-Api-Key': 'AIza-user-custom-key',
        'X-AI-Base-Url': 'https://generativelanguage.googleapis.com',
        'X-AI-Model': 'gemini-2.5-flash',
      },
      body: '{}',
    });
    assert.equal(geminiTestRes.status, 200);
    assert.equal(
      capturedCalls[1].url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
    );
    assert.equal(capturedCalls[1].headers['x-goog-api-key'], 'AIza-user-custom-key');

    // 4. Anthropic Claude native protocol
    const claudeTestRes = await fetch(`${srv.baseUrl}/api/v1/ai/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AI-Protocol': 'anthropic',
        'X-AI-Api-Key': 'sk-ant-user-custom-key',
        'X-AI-Base-Url': 'https://api.anthropic.com',
        'X-AI-Model': 'claude-sonnet-4-20250514',
      },
      body: '{}',
    });
    assert.equal(claudeTestRes.status, 200);
    assert.equal(capturedCalls[2].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(capturedCalls[2].headers['x-api-key'], 'sk-ant-user-custom-key');
  } finally {
    await srv.close();
  }
});

test('POST /api/v1/price-lookup aggregates Xianyu + Mercari adapters, caches 48h TTL, and supports force_refresh bypass', async () => {
  let adapterCallCount = 0;
  const mockXianyuMercariSource: BasePriceSource = {
    name: 'mock_dual_market',
    isEnabled: () => true,
    async lookup(query: PriceLookupQuery) {
      adapterCallCount++;
      const today = new Date().toISOString().slice(0, 10);
      if (query.label.includes('研磨')) {
        return [
          {
            platform: '闲鱼',
            title: '排球少年 孤爪研磨 原画展吧唧 单出',
            rawPrice: 84,
            currency: 'CNY',
            listedAt: today,
            url: 'https://www.goofish.com/item?id=1001',
            sold: true,
            matchesSeries: true,
          },
          {
            platform: '煤炉 Mercari',
            title: 'ハイキュー 孤爪研磨 缶バッジ',
            rawPrice: 1600,
            currency: 'JPY',
            listedAt: today,
            url: 'https://jp.mercari.com/item/m1001',
            sold: true,
            matchesSeries: true,
          },
        ];
      }
      return [
        {
          platform: '闲鱼',
          title: '排球少年 犬冈走 吧唧 单出',
          rawPrice: 12,
          currency: 'CNY',
          listedAt: today,
          sold: true,
          matchesSeries: true,
        },
        {
          platform: '闲鱼',
          title: '排球 犬冈走 吧唧',
          rawPrice: 14,
          currency: 'CNY',
          listedAt: today,
          matchesSeries: true,
        },
      ];
    },
  };

  const lookupService = new PriceLookupService({ sources: [mockXianyuMercariSource] });
  const srv = await startTestServer({ priceLookupService: lookupService });

  try {
    const payload = {
      ip_name: '排球少年',
      category: '吧唧',
      jpy_rate: 0.048,
      items: [
        {
          id: 'k1',
          label: '孤爪研磨',
          series_hint: '原画展吧唧',
          jp_keywords: 'ハイキュー 孤爪研磨 缶バッジ',
          weight: 1.0,
        },
        {
          id: 'k2',
          label: '犬冈走',
          series_hint: '原画展吧唧',
          weight: 1.0,
        },
      ],
    };

    // 1. Initial lookup hits live adapter -> from_cache: false
    const firstRes = await fetch(`${srv.baseUrl}/api/v1/price-lookup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Access-Token': 'test-code-001',
      },
      body: JSON.stringify(payload),
    });
    assert.equal(firstRes.status, 200);
    const firstData = (await firstRes.json()) as {
      items: Array<{
        id: string;
        weight: number;
        weight_source: string;
        market_price: {
          market_price_median: number;
          sample_count: number;
          pricing_tier: string;
          from_cache: boolean;
        };
      }>;
    };
    assert.equal(adapterCallCount, 2);
    assert.equal(firstData.items[0].weight_source, 'market_lookup');
    assert.equal(firstData.items[0].market_price.pricing_tier, 'exact_market');
    assert.equal(firstData.items[0].market_price.from_cache, false);
    assert.ok(firstData.items[0].weight > firstData.items[1].weight * 5);

    // 2. Second lookup within 48h hits cache -> adapterCallCount unchanged, from_cache: true
    const cachedRes = await fetch(`${srv.baseUrl}/api/v1/price-lookup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Access-Token': 'test-code-001',
      },
      body: JSON.stringify(payload),
    });
    assert.equal(cachedRes.status, 200);
    const cachedData = (await cachedRes.json()) as typeof firstData;
    assert.equal(adapterCallCount, 2);
    assert.equal(cachedData.items[0].market_price.from_cache, true);

    // 3. Lookup with force_refresh: true penetrates cache -> adapterCallCount increases to 4
    const forceRes = await fetch(`${srv.baseUrl}/api/v1/price-lookup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Access-Token': 'test-code-001',
      },
      body: JSON.stringify({ ...payload, force_refresh: true }),
    });
    assert.equal(forceRes.status, 200);
    const forceData = (await forceRes.json()) as typeof firstData;
    assert.equal(adapterCallCount, 4);
    assert.equal(forceData.items[0].market_price.from_cache, false);
  } finally {
    await srv.close();
  }
});

test('Phase 3 Multi-User Group-Buy: atomic anti-oversell under 8 concurrent claims, H5 page, contact masking, cancel & secondary sync', async () => {
  const srv = await startTestServer();

  try {
    // 1. Organizer publishes group order with 1 scarce hot item (total_qty = 1) and 1 normal item (total_qty = 2)
    const pubRes = await fetch(`${srv.baseUrl}/api/v1/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '排球少年原画展拼团',
        ip_name: '排球少年',
        annotated_image_data_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        items: [
          { source_item_id: 's1', label: '孤爪研磨', price: 82, prepaid_price: 82, total_qty: 1, tag: '热烫' },
          { source_item_id: 's2', label: '日向翔阳', price: 42, prepaid_price: 42, total_qty: 2, tag: '' },
        ],
      }),
    });
    assert.equal(pubRes.status, 201);
    const pubData = (await pubRes.json()) as {
      share_code: string;
      owner_token: string;
      order: { items: Array<{ id: string; label: string; remaining_qty: number }> };
    };
    const shareCode = pubData.share_code;
    const ownerToken = pubData.owner_token;
    const scarceItemId = pubData.order.items[0].id;

    // 2. Mobile H5 page GET /g/:shareCode renders 200 HTML
    const h5Res = await fetch(`${srv.baseUrl}/g/${shareCode}`);
    assert.equal(h5Res.status, 200);
    const h5Html = await h5Res.text();
    assert.ok(h5Html.includes('排球少年原画展拼团'));

    // 3. Fire 8 simultaneous concurrent POST /claim requests competing for total_qty = 1
    const concurrentResponses = await Promise.all(
      Array.from({ length: 8 }, (_, idx) =>
        fetch(`${srv.baseUrl}/api/v1/groups/${shareCode}/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            item_id: scarceItemId,
            buyer_name: `并发团员${idx + 1}`,
            buyer_contact: `QQ1380013800${idx}`,
            qty: 1,
          }),
        })
      )
    );

    const okClaims = concurrentResponses.filter((r) => r.status === 200);
    const conflictClaims = concurrentResponses.filter((r) => r.status === 409);
    assert.equal(okClaims.length, 1, 'Strictly 1 buyer must succeed on total_qty=1');
    assert.equal(conflictClaims.length, 7, 'All other 7 concurrent buyers must receive 409 Conflict');

    const winnerBody = (await okClaims[0].json()) as { claim_id: string; claim_token: string };

    // 4. Public GET masks buyer_contact, while Organizer Bearer GET shows full buyer_contact
    const pubViewRes = await fetch(`${srv.baseUrl}/api/v1/groups/${shareCode}`);
    const pubView = (await pubViewRes.json()) as {
      is_owner: boolean;
      order: { claims: Array<{ buyer_contact: string }> };
    };
    assert.equal(pubView.is_owner, false);
    assert.ok(pubView.order.claims[0].buyer_contact.includes('****'));

    const ownerViewRes = await fetch(`${srv.baseUrl}/api/v1/groups/${shareCode}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const ownerView = (await ownerViewRes.json()) as {
      is_owner: boolean;
      order: { claims: Array<{ buyer_contact: string }> };
    };
    assert.equal(ownerView.is_owner, true);
    assert.ok(!ownerView.order.claims[0].buyer_contact.includes('****'));

    // 5. Organizer syncs secondary-settlement price change (82 -> 90) -> buyer_bills reflects +8 supplement
    const syncRes = await fetch(`${srv.baseUrl}/api/v1/groups/${shareCode}/sync`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        status: 'settled',
        items: [
          { source_item_id: 's1', label: '孤爪研磨', price: 90, prepaid_price: 82, total_qty: 1, tag: '热烫' },
          { source_item_id: 's2', label: '日向翔阳', price: 42, prepaid_price: 42, total_qty: 2, tag: '' },
        ],
      }),
    });
    assert.equal(syncRes.status, 200);
    const syncData = (await syncRes.json()) as {
      order: { buyer_bills: Array<{ total_amount: number; prepaid_total: number; delta_total: number }> };
    };
    assert.equal(syncData.order.buyer_bills[0].total_amount, 90);
    assert.equal(syncData.order.buyer_bills[0].prepaid_total, 82);
    assert.equal(syncData.order.buyer_bills[0].delta_total, 8);

    // 6. Cancel claim releases stock back to remaining_qty = 1
    const cancelRes = await fetch(
      `${srv.baseUrl}/api/v1/groups/${shareCode}/claims/${winnerBody.claim_id}`,
      {
        method: 'DELETE',
        headers: { 'X-Claim-Token': winnerBody.claim_token },
      }
    );
    assert.equal(cancelRes.status, 200);
    const afterCancel = (await cancelRes.json()) as {
      order: { items: Array<{ remaining_qty: number }> };
    };
    assert.equal(afterCancel.order.items[0].remaining_qty, 1);
  } finally {
    await srv.close();
  }
});

test('POST /api/v1/market/contribute enforces project_id idempotency and price variance filtering', async () => {
  const srv = await startTestServer();
  try {
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
