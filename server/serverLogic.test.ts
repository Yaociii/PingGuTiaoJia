import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanDirtyJson,
  normalizeVlmBox,
  parseAutoPriceResponseText,
  parseVlmResponseText,
} from './vlmParser';
import {
  computeTimeDecayFactor,
  computeUpdatedWeightRatio,
  isMarketStatStale,
  isPlaceholderLabel,
  matchMarketStat,
  normalizeKey,
} from './marketMatcher';
import {
  cleanAndAggregateMarketSamples,
  convertToCny,
  isBundleOrLotListing,
  normalizeMarketPricesToWeights,
} from './priceLookup';
import {
  resolveAnthropicEndpoint,
  resolveGeminiEndpoint,
  resolveOpenAiChatEndpoint,
  validateSafeExternalBaseUrl,
} from './vlmProvider';
import type { CharacterMarketStatRecord } from './types';

test('cleanDirtyJson strips markdown fences, text wrappers, and trailing commas', () => {
  const dirty = `
  好的，以下是识别结果：
  \`\`\`json
  {
    "ip_name": "排球少年",
    "items": [
      { "label": "孤爪研磨", "box": [120, 80, 410, 320], "weight": 2.4, },
    ],
  }
  \`\`\`
  希望帮到你！
  `;
  const cleaned = cleanDirtyJson(dirty);
  const parsed = JSON.parse(cleaned);
  assert.equal(parsed.ip_name, '排球少年');
  assert.equal(parsed.items.length, 1);
});

test('normalizeVlmBox handles 0~1000, 0~1, and pixel coordinates with anti-face anchor', () => {
  const from1000 = normalizeVlmBox([100, 200, 500, 600]);
  assert.ok(from1000);
  assert.deepEqual(from1000.box, [0.1, 0.2, 0.5, 0.6]);
  assert.equal(from1000.x, 0.4);
  assert.equal(from1000.y, 0.44); // 0.1 + 0.4 * 0.85

  const from01 = normalizeVlmBox([0.1, 0.2, 0.5, 0.6]);
  assert.ok(from01);
  assert.deepEqual(from01.box, [0.1, 0.2, 0.5, 0.6]);

  const fromPixels = normalizeVlmBox([200, 400, 1000, 1200], 2000, 2000);
  assert.ok(fromPixels);
  assert.deepEqual(fromPixels.box, [0.1, 0.2, 0.5, 0.6]);

  // Tiny noise box < 0.001 area is rejected
  assert.equal(normalizeVlmBox([10, 10, 20, 20]), null);
});

test('parseVlmResponseText parses V2.0 structured fields and clamps wide weights [0.1, 10.0]', () => {
  const raw = `\`\`\`json
  {
    "ip_name": "排球少年",
    "series_hint": "原画展闪底吧唧",
    "items": [
      {
        "label": "孤爪研磨",
        "series_hint": "原画展第2弹",
        "item_type": "吧唧",
        "jp_keywords": "ハイキュー 孤爪研磨 缶バッジ",
        "box": [100, 100, 400, 350],
        "weight": 4.2
      },
      { "label": "隐藏款", "box": [100, 400, 400, 650], "weight": 15.0 },
      { "label": "犬冈走", "box": [500, 400, 800, 650], "weight": 0.02 }
    ]
  }
  \`\`\``;
  const parsed = parseVlmResponseText(raw);
  assert.equal(parsed.ip_name, '排球少年');
  assert.equal(parsed.items.length, 3);
  assert.equal(parsed.items[0].series_hint, '原画展第2弹');
  assert.equal(parsed.items[0].item_type, '吧唧');
  assert.equal(parsed.items[0].jp_keywords, 'ハイキュー 孤爪研磨 缶バッジ');
  assert.equal(parsed.items[0].weight, 4.2); // preserved within [0.1, 10.0]
  assert.equal(parsed.items[1].weight, 10.0); // clamped to max 10.0
  assert.equal(parsed.items[2].weight, 0.1); // clamped to min 0.1
});

test('matchMarketStat supports containment matching, sample_count >= 3, and 90-day staleness governance', () => {
  const now = new Date('2026-11-24T00:00:00Z');
  const stats: CharacterMarketStatRecord[] = [
    {
      id: 1,
      ip_name: '排球少年',
      character_name: '孤爪研磨',
      normalized_key: normalizeKey('孤爪研磨'),
      category: '吧唧',
      avg_weight_ratio: 2.35,
      sample_count: 12,
      updated_at: '2026-11-20T00:00:00Z', // 4 days ago (fresh)
    },
    {
      id: 2,
      ip_name: '排球少年',
      character_name: '黑尾铁朗',
      normalized_key: normalizeKey('黑尾铁朗'),
      category: '通用',
      avg_weight_ratio: 1.9,
      sample_count: 2, // below threshold of 3
      updated_at: '2026-11-20T00:00:00Z',
    },
    {
      id: 3,
      ip_name: '排球少年',
      character_name: '过气旧热度角色',
      normalized_key: normalizeKey('过气旧热度角色'),
      category: '吧唧',
      avg_weight_ratio: 3.1,
      sample_count: 15,
      updated_at: '2026-06-01T00:00:00Z', // > 90 days ago (stale)
    },
  ];

  const hit = matchMarketStat(stats, '排球少年', '研磨', '吧唧', { now });
  assert.ok(hit);
  assert.equal(hit.avg_weight_ratio, 2.35);

  const missLowSample = matchMarketStat(stats, '排球少年', '黑尾铁朗', '吧唧', { now });
  assert.equal(missLowSample, null);

  assert.equal(isMarketStatStale('2026-06-01T00:00:00Z', now), true);
  const missStale = matchMarketStat(stats, '排球少年', '过气旧热度角色', '吧唧', {
    now,
    allowStale: false,
  });
  assert.equal(missStale, null);
});

test('computeUpdatedWeightRatio applies 45-day half-life exponential time decay', () => {
  const now = new Date('2026-11-24T00:00:00Z');
  const fortyFiveDaysAgo = new Date(now.getTime() - 45 * 24 * 3600 * 1000).toISOString();

  // Exactly 45 days elapsed -> decay factor = 0.5
  const decay = computeTimeDecayFactor(fortyFiveDaysAgo, now, 45);
  assert.ok(Math.abs(decay - 0.5) < 1e-6);

  // Old ratio 3.0 with 8 samples from 45 days ago -> effective_n = 4
  // New sample ratio = 30 / 30 = 1.0 -> (3.0 * 4 + 1.0) / 5 = 2.6
  const decayedUpdate = computeUpdatedWeightRatio(3.0, 8, 30, 30, {
    lastUpdatedAt: fortyFiveDaysAgo,
    now,
    halfLifeDays: 45,
  });
  assert.equal(decayedUpdate.effective_n, 4);
  assert.equal(decayedUpdate.avg_weight_ratio, 2.6);
  assert.equal(decayedUpdate.sample_count, 9);
});

test('priceLookup filters bundles, clickbait, >90d stale samples, converts JPY, and runs IQR outlier removal', () => {
  assert.equal(isBundleOrLotListing('排球少年 原画展吧唧 抱盒全套出'), true);
  assert.equal(isBundleOrLotListing('ハイキュー 缶バッジ まとめ売り 10点'), true);
  assert.equal(isBundleOrLotListing('排球少年 孤爪研磨 原画展吧唧 单出'), false);

  // 1500 JPY * 0.048 * 1.12 = 80.64 CNY
  assert.equal(convertToCny(1500, 'JPY', 0.048, 0.12), 80.64);

  const now = new Date('2026-11-24T00:00:00Z');
  const cleaned = cleanAndAggregateMarketSamples(
    [
      { platform: '闲鱼', title: '研磨吧唧 引流', rawPrice: 1, currency: 'CNY', listedAt: '2026-11-22' },
      { platform: '闲鱼', title: '研磨吧唧 防拍展示', rawPrice: 9999, currency: 'CNY', listedAt: '2026-11-22' },
      { platform: '闲鱼', title: '排球原画展 抱盒全套', rawPrice: 480, currency: 'CNY', listedAt: '2026-11-22' },
      { platform: '闲鱼', title: '半年前老旧挂单', rawPrice: 150, currency: 'CNY', listedAt: '2026-05-01' },
      // Valid fresh single-item samples + 1 extreme high outlier (320 CNY) removed by IQR
      { platform: '闲鱼', title: '孤爪研磨 原画展吧唧 单出', rawPrice: 82, currency: 'CNY', listedAt: '2026-11-22', sold: true, matchesSeries: true },
      { platform: '闲鱼', title: '研磨 原画展吧唧 好价出', rawPrice: 86, currency: 'CNY', listedAt: '2026-11-20', matchesSeries: true },
      { platform: '闲鱼', title: '孤爪研磨 吧唧 仅拆确认', rawPrice: 84, currency: 'CNY', listedAt: '2026-11-18', sold: true, matchesSeries: true },
      { platform: '煤炉 Mercari', title: 'ハイキュー 孤爪研磨 缶バッジ', rawPrice: 1550, currency: 'JPY', listedAt: '2026-11-19', matchesSeries: true },
      { platform: '闲鱼', title: '离谱高价挂单测试IQR', rawPrice: 320, currency: 'CNY', listedAt: '2026-11-21', matchesSeries: true },
    ],
    { now, jpyRate: 0.048, intlShippingFactor: 0.12, hasSeriesHint: true }
  );

  // 4 valid inliers (~82, 83.33, 84, 86); 320 outlier removed by IQR!
  assert.equal(cleaned.sampleCount, 4);
  assert.equal(cleaned.pricingTier, 'exact_market');
  assert.equal(cleaned.freshness, 'fresh');
  assert.ok(cleaned.median !== null && cleaned.median >= 82 && cleaned.median <= 86);

  // Market median normalization preserves exact ratio (85 : 12)
  const weights = normalizeMarketPricesToWeights([
    { id: 'hot', median: 85, fallbackWeight: 1 },
    { id: 'cold', median: 12, fallbackWeight: 1 },
  ]);
  const ratio = (weights.get('hot') || 1) / (weights.get('cold') || 1);
  assert.ok(Math.abs(ratio - 85 / 12) < 0.25);
});

test('isPlaceholderLabel filters default placeholder names', () => {
  assert.equal(isPlaceholderLabel('123'), true);
  assert.equal(isPlaceholderLabel('谷子1'), true);
  assert.equal(isPlaceholderLabel('孤爪研磨'), false);
});

test('validateSafeExternalBaseUrl blocks SSRF / non-HTTPS / private IPs and allows public HTTPS endpoints', () => {
  const blocked = [
    'http://api.openai.com/v1',
    'https://localhost:8080/v1',
    'https://127.0.0.1/v1',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.5/v1',
    'https://192.168.1.10/v1',
    'https://172.16.0.1/v1',
    'https://[::1]/v1',
    'https://user:pass@api.openai.com/v1',
    'https://metadata.google.internal/v1',
  ];
  for (const url of blocked) {
    assert.throws(() => validateSafeExternalBaseUrl(url), `Expected SSRF block for ${url}`);
  }

  assert.equal(
    resolveOpenAiChatEndpoint('https://dashscope.aliyuncs.com/compatible-mode/v1/'),
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
  );
  assert.equal(
    resolveOpenAiChatEndpoint('https://api.openai.com/v1/chat/completions'),
    'https://api.openai.com/v1/chat/completions'
  );
  assert.equal(
    resolveGeminiEndpoint('https://generativelanguage.googleapis.com', 'gemini-2.5-flash'),
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
  );
  assert.equal(
    resolveAnthropicEndpoint('https://api.anthropic.com'),
    'https://api.anthropic.com/v1/messages'
  );
});

test('parseAutoPriceResponseText parses dirty JSON, maps by id, and sanitizes tags and V2.0 wide weights', () => {
  const input = [
    { id: 'a1', label: '孤爪研磨', locked: false, price: 30, quantity: 1, weight: 1, tag: '' },
    { id: 'a2', label: '犬冈走', locked: false, price: 30, quantity: 1, weight: 1, tag: '' },
  ];
  const raw = `\`\`\`json
  {
    "ip_name": "排球少年",
    "summary": "热门上浮，冷门下调",
    "items": [
      { "id": "a1", "label": "孤爪研磨", "weight": 3.5, "tag": "热烫", "reason": "超人气", },
      { "id": "a2", "label": "犬冈走", "weight": 0.25, "tag": "非法标记", "reason": "冷门", },
    ],
  }
  \`\`\``;
  const parsed = parseAutoPriceResponseText(raw, input);
  assert.equal(parsed.ip_name, '排球少年');
  assert.equal(parsed.items[0].weight, 3.5); // wide weight preserved in V2.0
  assert.equal(parsed.items[0].tag, '热烫');
  assert.equal(parsed.items[1].weight, 0.25);
  assert.equal(parsed.items[1].tag, ''); // invalid tag sanitized
});

