import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { GachaDatabase } from './db';
import { createApiRouter } from './app';
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
  const dayOne = new Date();
  let currentNow = new Date(Date.UTC(dayOne.getUTCFullYear(), dayOne.getUTCMonth(), dayOne.getUTCDate(), 10, 0, 0));
  const srv = await startTestServer({ dailyLimit: 1, getNow: () => currentNow });

  try {
    // 1. Health check
    const healthRes = await fetch(`${srv.baseUrl}/api/v1/health`);
    assert.equal(healthRes.status, 200);
    const health = (await healthRes.json()) as { status: string; supported_protocols: string[] };
    assert.equal(health.status, 'ok');
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
    corruptForm.append('image', new Blob([Buffer.from('not-an-image-at-all')], { type: 'image/png' }), 'bad.png');
    const corruptRes = await fetch(`${srv.baseUrl}/api/v1/detect`, {
      method: 'POST',
      headers: { 'X-Access-Token': 'test-code-001' },
      body: corruptForm,
    });
    assert.equal(corruptRes.status, 400);

    // 4. Valid detect -> 200, fuses "研磨" with seeded "孤爪研磨" market_db weight (1.54)
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
    assert.equal(detected.items[0].weight, 1.54);
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
  const capturedCalls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];

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
                content: '{"ip_name":"排球少年","summary":"OpenAI测试","items":[{"id":"i1","label":"孤爪研磨","weight":1.5,"tag":"热烫","reason":"热"}]}',
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
    assert.equal(apData.items[0].weight, 1.54);
    assert.equal(capturedCalls[0].url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
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
