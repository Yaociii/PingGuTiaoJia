import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TEMPLATE_PRESETS,
  buildBuyerBillsSummaryText,
  buildGroupCsvContent,
  buildGroupXlsxBytes,
  renderGroupTemplateText,
  sanitizeSpreadsheetCellText,
} from './groupExport';
import type { GoodItem, GroupOrderDetail } from '../types/pricing';

const SAMPLE_ITEMS: GoodItem[] = [
  {
    id: '1',
    x: 0.2,
    y: 0.3,
    label: '孤爪研磨',
    seriesHint: '原画展闪底吧唧',
    weight: 2.35,
    quantity: 2,
    price: 45,
    locked: false,
    tag: '热烫',
  },
  {
    id: '2',
    x: 0.5,
    y: 0.3,
    label: '日向翔阳',
    weight: 1.0,
    quantity: 1,
    price: 30,
    locked: false,
    tag: '',
  },
  {
    id: '3',
    x: 0.8,
    y: 0.3,
    label: '黑尾铁朗',
    weight: 1.9,
    quantity: 1,
    price: 42,
    locked: false,
    tag: '自留',
  },
  {
    id: '4',
    x: 0.8,
    y: 0.6,
    label: '=CMD()恶意公式角色',
    weight: 0.5,
    quantity: 1,
    price: 15,
    locked: false,
    tag: '捆物',
  },
];

test('sanitizeSpreadsheetCellText escapes leading formula injection characters', () => {
  assert.equal(sanitizeSpreadsheetCellText('=SUM(A1:A2)'), "'=SUM(A1:A2)");
  assert.equal(sanitizeSpreadsheetCellText('+10086'), "'+10086");
  assert.equal(sanitizeSpreadsheetCellText('@admin'), "'@admin");
  assert.equal(sanitizeSpreadsheetCellText('孤爪研磨'), '孤爪研磨');
});

test('buildGroupCsvContent outputs UTF-8 BOM, standard 5 columns, filters self-kept items, and sanitizes formulas', () => {
  const csv = buildGroupCsvContent(SAMPLE_ITEMS, '排球少年');
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.includes('商品名称/角色,单价,总数量,捆绑/标签,备注'));
  assert.ok(csv.includes('孤爪研磨,45,2,热烫,排球少年 · 原画展闪底吧唧'));
  assert.ok(!csv.includes('黑尾铁朗')); // filtered because tag === '自留'
  assert.ok(csv.includes("'=CMD()恶意公式角色,15,1,捆物,排球少年"));
});

test('buildGroupXlsxBytes creates valid PKZIP OOXML .xlsx archive with sheet1.xml data', () => {
  const bytes = buildGroupXlsxBytes(SAMPLE_ITEMS, '排球少年');
  // PK\x03\x04 local file header signature
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);
  assert.equal(bytes[2], 0x03);
  assert.equal(bytes[3], 0x04);

  const decoded = new TextDecoder().decode(bytes);
  assert.ok(decoded.includes('xl/worksheets/sheet1.xml'));
  assert.ok(decoded.includes('商品名称/角色'));
  assert.ok(decoded.includes('孤爪研磨'));
  assert.ok(decoded.includes('<c r="B2"><v>45</v></c>'));
  assert.ok(decoded.includes('<c r="C2"><v>2</v></c>'));
});

test('renderGroupTemplateText supports mini-program batch preset, chat solitaire, and custom variables', () => {
  const batchText = renderGroupTemplateText({
    projectName: '原画展第2弹',
    ipName: '排球少年',
    items: SAMPLE_ITEMS.slice(0, 3),
    lineTemplate: TEMPLATE_PRESETS.miniapp_batch.lineTemplate,
    includeHeaderFooter: false,
  });
  const lines = batchText.split('\n');
  assert.equal(lines.length, 2); // 黑尾铁朗自留 excluded
  assert.equal(lines[0], '孤爪研磨 45*2 [热烫]');
  assert.equal(lines[1], '日向翔阳 30*1'); // empty [{{tag}}] stripped cleanly

  const solitaireText = renderGroupTemplateText({
    projectName: '原画展第2弹',
    ipName: '排球少年',
    items: SAMPLE_ITEMS.slice(0, 3),
    lineTemplate: TEMPLATE_PRESETS.chat_solitaire.lineTemplate,
    includeHeaderFooter: true,
  });
  assert.ok(solitaireText.includes('【排球少年 · 原画展第2弹 开团排表】'));
  assert.ok(solitaireText.includes('团长自留：黑尾铁朗'));
});

test('buildBuyerBillsSummaryText formats per-buyer totals and secondary-settlement deltas', () => {
  const order: GroupOrderDetail = {
    id: 'ord-1',
    shareCode: 'ABC123',
    shareUrl: '/g/ABC123',
    title: '排球盲抽3盒团',
    ipName: '排球少年',
    status: 'settled',
    annotatedImageDataUrl: '',
    createdAt: '2026-11-24T00:00:00Z',
    updatedAt: '2026-11-24T01:00:00Z',
    items: [],
    claims: [],
    buyerBills: [
      {
        buyerName: '猫猫老师',
        buyerContact: 'QQ 88886666',
        totalQty: 2,
        totalAmount: 90,
        prepaidTotal: 70,
        deltaTotal: 20,
        items: [
          {
            itemId: 'i1',
            label: '孤爪研磨',
            qty: 2,
            unitPrice: 45,
            prepaidPrice: 35,
            delta: 20,
          },
        ],
      },
    ],
  };

  const billText = buildBuyerBillsSummaryText(order);
  assert.ok(billText.includes('@猫猫老师（QQ 88886666）：共 2 件，应付 ¥90'));
  assert.ok(billText.includes('二调需补 +¥20'));
  assert.ok(billText.includes('肾表应收总计：¥90'));
});
