import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calcTargetTotal,
  calcSecondarySettlement,
  rebalanceItems,
} from './rebalancer';
import type { CostConfig, GoodItem } from '../types/pricing';

function makeItem(partial: Partial<GoodItem> & { id: string }): GoodItem {
  return {
    x: 0.5,
    y: 0.5,
    label: `角色${partial.id}`,
    weight: 1,
    quantity: 1,
    price: 0,
    locked: false,
    tag: '',
    ...partial,
  };
}

test('calcTargetTotal calculates direct and foreign modes accurately', () => {
  const direct: CostConfig = {
    mode: 'direct',
    targetTotal: 280,
    foreignPrice: 5000,
    exchangeRate: 0.048,
    shippingFee: 30,
    feeRate: 0.01,
    step: 1,
  };
  assert.equal(calcTargetTotal(direct), 280);

  const foreign: CostConfig = {
    ...direct,
    mode: 'foreign',
    foreignPrice: 6000,
    exchangeRate: 0.048,
    shippingFee: 32,
    feeRate: 0.01,
  };
  // (6000 * 0.048 + 32) * 1.01 = (288 + 32) * 1.01 = 323.2
  assert.equal(calcTargetTotal(foreign), 323.2);
});

test('rebalanceItems preserves exact total for step = 0.5, 1, and 5', () => {
  const items = [
    makeItem({ id: '1', label: '孤爪研磨', weight: 1.5 }),
    makeItem({ id: '2', label: '黑尾铁朗', weight: 1.35 }),
    makeItem({ id: '3', label: '日向翔阳', weight: 1.15 }),
    makeItem({ id: '4', label: '影山飞雄', weight: 1.1 }),
    makeItem({ id: '5', label: '夜久卫辅', weight: 0.85 }),
    makeItem({ id: '6', label: '犬冈走', weight: 0.6 }),
  ];

  for (const [step, target] of [
    [0.5, 197.5],
    [1, 200],
    [5, 210],
  ] as const) {
    const res = rebalanceItems(items, target, step);
    assert.equal(res.status, 'OK');
    assert.equal(res.actualTotal, target);
    assert.equal(res.residual, 0);
    for (const it of res.items) {
      assert.equal(Math.round(it.price / step) * step, it.price);
    }
    // Hotter character gets >= colder character
    assert.ok(res.items[0].price >= res.items[5].price);
  }
});

test('rebalanceItems respects locked items and prevents negative prices on exceed', () => {
  const items = [
    makeItem({ id: '1', label: '热角A', price: 60, locked: true, weight: 1.5 }),
    makeItem({ id: '2', label: '热角B', price: 50, locked: true, weight: 1.2 }),
    makeItem({ id: '3', label: '普角C', weight: 1.0 }),
    makeItem({ id: '4', label: '冷角D', weight: 0.6 }),
  ];

  // Normal case: target 160, locked = 110, remaining = 50
  const okRes = rebalanceItems(items, 160, 1);
  assert.equal(okRes.status, 'OK');
  assert.equal(okRes.actualTotal, 160);
  assert.equal(okRes.items[0].price, 60);
  assert.equal(okRes.items[1].price, 50);
  assert.equal(okRes.items[2].price + okRes.items[3].price, 50);

  // Exceed case: target 95, locked = 110 -> LOCKED_EXCEEDS_TARGET, exceedAmount = 15, unlocked = 0
  const exceedRes = rebalanceItems(items, 95, 1);
  assert.equal(exceedRes.status, 'LOCKED_EXCEEDS_TARGET');
  assert.equal(exceedRes.exceedAmount, 15);
  assert.equal(exceedRes.items[2].price, 0);
  assert.equal(exceedRes.items[3].price, 0);
});

test('rebalanceItems enforces minPrice and maxPrice water-filling constraints', () => {
  const items = [
    makeItem({ id: '1', label: '上限角', weight: 3.0, maxPrice: 40 }),
    makeItem({ id: '2', label: '下限角', weight: 0.1, minPrice: 20 }),
    makeItem({ id: '3', label: '中间角A', weight: 1.0 }),
    makeItem({ id: '4', label: '中间角B', weight: 1.0 }),
  ];

  const res = rebalanceItems(items, 120, 1);
  assert.equal(res.status, 'OK');
  assert.equal(res.actualTotal, 120);
  assert.ok(res.items[0].price <= 40);
  assert.ok(res.items[1].price >= 20);
});

test('rebalanceItems handles quantity = 0 and quantity >= 2 (blind-box secondary adjustment)', () => {
  const items = [
    makeItem({ id: '1', label: '未抽中', quantity: 0, price: 35, weight: 1.2 }),
    makeItem({ id: '2', label: '复数热角', quantity: 2, weight: 1.4 }),
    makeItem({ id: '3', label: '复数冷角', quantity: 2, weight: 0.8 }),
  ];

  // Even target 100 with quantities 2 & 2 (all even) -> exact match
  const exactRes = rebalanceItems(items, 100, 1);
  assert.equal(exactRes.items[0].price, 0);
  assert.equal(exactRes.actualTotal, 100);
  assert.equal(exactRes.status, 'OK');

  // Odd target 101 with only Q=2 items and step=1 -> mathematically indivisible, flags RESIDUAL_NONZERO
  const oddRes = rebalanceItems(items, 101, 1);
  assert.equal(oddRes.items[0].price, 0);
  assert.equal(oddRes.status, 'RESIDUAL_NONZERO');
  assert.equal(Math.abs(oddRes.residual), 1);
});

test('rebalanceItems returns NO_UNLOCKED_ITEMS when all active items are locked with residual', () => {
  const items = [
    makeItem({ id: '1', price: 30, locked: true }),
    makeItem({ id: '2', price: 40, locked: true }),
  ];
  const res = rebalanceItems(items, 80, 1);
  assert.equal(res.status, 'NO_UNLOCKED_ITEMS');
  assert.equal(res.residual, -10);
});

test('calcSecondarySettlement computes refund/supplement rows and announcement text', () => {
  const items = [
    makeItem({ id: '1', label: '孤爪研磨', quantity: 2, price: 45, prepaidPrice: 35 }),
    makeItem({ id: '2', label: '犬冈走', quantity: 1, price: 20, prepaidPrice: 35 }),
    makeItem({ id: '3', label: '福永招平', quantity: 0, price: 0, prepaidPrice: 35 }),
  ];

  const settlement = calcSecondarySettlement(items, '排球少年吧唧二调');
  assert.equal(settlement.rows.length, 2);
  assert.deepEqual(settlement.zeroQtyLabels, ['福永招平']);
  assert.equal(settlement.rows[0].deltaPerItem, 10);
  assert.equal(settlement.rows[0].subtotalDelta, 20);
  assert.equal(settlement.rows[1].deltaPerItem, -15);
  assert.equal(settlement.totalPrepaid, 105);
  assert.equal(settlement.totalFinal, 110);
  assert.equal(settlement.totalDelta, 5);
  assert.ok(settlement.announcementText.includes('孤爪研磨 ×2'));
  assert.ok(settlement.announcementText.includes('需补 ¥10/件'));
  assert.ok(settlement.announcementText.includes('应退 ¥15/件'));
  assert.ok(settlement.announcementText.includes('未出货角色：福永招平'));
});
