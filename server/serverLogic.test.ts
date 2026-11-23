import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanDirtyJson, normalizeVlmBox, parseVlmResponseText } from './vlmParser';
import {
  computeUpdatedWeightRatio,
  isPlaceholderLabel,
  matchMarketStat,
  normalizeKey,
} from './marketMatcher';
import type { CharacterMarketStatRecord } from './types';

test('cleanDirtyJson strips markdown fences, text wrappers, and trailing commas', () => {
  const dirty = `
  好的，以下是识别结果：
  \`\`\`json
  {
    "ip_name": "排球少年",
    "items": [
      { "label": "孤爪研磨", "box": [120, 80, 410, 320], "weight": 1.4, },
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

test('parseVlmResponseText parses dirty VLM response and clamps weights', () => {
  const raw = `\`\`\`json
  {
    "ip_name": "排球少年",
    "items": [
      { "label": "孤爪研磨", "box": [100, 100, 400, 350], "weight": 4.2, },
      { "label": "犬冈走", "box": [100, 400, 400, 650], "weight": 0.1, }
    ]
  }
  \`\`\``;
  const parsed = parseVlmResponseText(raw);
  assert.equal(parsed.ip_name, '排球少年');
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].weight, 2.5);
  assert.equal(parsed.items[1].weight, 0.3);
});

test('matchMarketStat supports exact, containment, fuzzy matching, and sample_count >= 3 threshold', () => {
  const stats: CharacterMarketStatRecord[] = [
    {
      id: 1,
      ip_name: '排球少年',
      character_name: '孤爪研磨',
      normalized_key: normalizeKey('孤爪研磨'),
      category: '吧唧',
      avg_weight_ratio: 1.52,
      sample_count: 12,
      updated_at: '2026-11-20T00:00:00Z',
    },
    {
      id: 2,
      ip_name: '排球少年',
      character_name: '黑尾铁朗',
      normalized_key: normalizeKey('黑尾铁朗'),
      category: '通用',
      avg_weight_ratio: 1.38,
      sample_count: 2, // below threshold of 3
      updated_at: '2026-11-20T00:00:00Z',
    },
  ];

  // Containment alias "研磨" -> matches "孤爪研磨"
  const hit = matchMarketStat(stats, '排球少年', '研磨', '吧唧');
  assert.ok(hit);
  assert.equal(hit.avg_weight_ratio, 1.52);

  // Sample count < 3 should NOT override VLM weight
  const missLowSample = matchMarketStat(stats, '排球少年', '黑尾铁朗', '吧唧');
  assert.equal(missLowSample, null);
});

test('computeUpdatedWeightRatio uses cumulative avg under 20 and EMA at 20+', () => {
  const first = computeUpdatedWeightRatio(1.0, 0, 45, 30);
  assert.equal(first.avg_weight_ratio, 1.5);
  assert.equal(first.sample_count, 1);

  const second = computeUpdatedWeightRatio(1.5, 1, 30, 30);
  assert.equal(second.avg_weight_ratio, 1.25);
  assert.equal(second.sample_count, 2);

  const ema = computeUpdatedWeightRatio(1.5, 20, 30, 30);
  // 0.9 * 1.5 + 0.1 * 1.0 = 1.45
  assert.equal(ema.avg_weight_ratio, 1.45);
  assert.equal(ema.sample_count, 21);
});

test('isPlaceholderLabel filters default placeholder names', () => {
  assert.equal(isPlaceholderLabel('123'), true);
  assert.equal(isPlaceholderLabel('谷子1'), true);
  assert.equal(isPlaceholderLabel('孤爪研磨'), false);
});
