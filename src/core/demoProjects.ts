import type { GachaProject, ItemMarketPriceInfo } from '../types/pricing';
import { rebalanceItems, calcTargetTotal } from './rebalancer';

/**
 * Crisp high-resolution procedural SVG flat-lay of 8 glossy metal can badges (吧唧)
 * Used for the second seeded demo project (排球少年 8枚抱盒吧唧) with zero broken-image risk.
 */
function buildBadgeSheetDataUrl(): string {
  const badges = [
    { name: 'KENMA', num: '05', bg1: '#F59E0B', bg2: '#B91C1C', accent: '#FEF3C7', hair: '#1E293B', row: 0, col: 0 },
    { name: 'KUROO', num: '01', bg1: '#DC2626', bg2: '#7F1D1D', accent: '#FEE2E2', hair: '#0F172A', row: 0, col: 1 },
    { name: 'OIKAWA', num: '01', bg1: '#14B8A6', bg2: '#0F766E', accent: '#CCFBF1', hair: '#78350F', row: 0, col: 2 },
    { name: 'HINATA', num: '10', bg1: '#EA580C', bg2: '#9A3412', accent: '#FFEDD5', hair: '#F97316', row: 0, col: 3 },
    { name: 'KAGEYAMA', num: '09', bg1: '#1D4ED8', bg2: '#1E3A8A', accent: '#DBEAFE', hair: '#0F172A', row: 1, col: 0 },
    { name: 'TSUKKI', num: '11', bg1: '#CA8A04', bg2: '#713F12', accent: '#FEF9C3', hair: '#EAB308', row: 1, col: 1 },
    { name: 'YAKU', num: '03', bg1: '#E11D48', bg2: '#881337', accent: '#FFE4E6', hair: '#92400E', row: 1, col: 2 },
    { name: 'INUOKA', num: '07', bg1: '#475569', bg2: '#1E293B', accent: '#E2E8F0', hair: '#334155', row: 1, col: 3 },
  ];

  const badgeSvgs = badges
    .map((b, idx) => {
      const cx = 180 + b.col * 280;
      const cy = 240 + b.row * 410;
      const r = 112;
      return `
      <g>
        <defs>
          <radialGradient id="grad-${idx}" cx="35%" cy="30%" r="72%">
            <stop offset="0%" stop-color="${b.bg1}"/>
            <stop offset="100%" stop-color="${b.bg2}"/>
          </radialGradient>
          <clipPath id="clip-${idx}">
            <circle cx="${cx}" cy="${cy}" r="${r - 5}"/>
          </clipPath>
        </defs>
        <circle cx="${cx}" cy="${cy + 14}" r="${r}" fill="rgba(15,23,42,0.14)" filter="url(#shadow)"/>
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="#E2E8F0" stroke="#CBD5E1" stroke-width="2"/>
        <circle cx="${cx}" cy="${cy}" r="${r - 5}" fill="url(#grad-${idx})"/>
        <g clip-path="url(#clip-${idx})">
          <path d="M${cx - 120} ${cy + 50} L${cx + 120} ${cy - 45} L${cx + 120} ${cy + 15} L${cx - 120} ${cy + 110} Z" fill="rgba(255,255,255,0.12)"/>
          <circle cx="${cx}" cy="${cy - 18}" r="36" fill="${b.accent}"/>
          <path d="M${cx - 38} ${cy - 22} Q${cx} ${cy - 68} ${cx + 38} ${cy - 22} Q${cx + 22} ${cy - 34} ${cx} ${cy - 30} Q${cx - 22} ${cy - 34} ${cx - 38} ${cy - 22} Z" fill="${b.hair}"/>
          <path d="M${cx - 62} ${cy + 98} Q${cx - 54} ${cy + 26} ${cx} ${cy + 24} Q${cx + 54} ${cy + 26} ${cx + 62} ${cy + 98} Z" fill="#0F172A" opacity="0.82"/>
          <text x="${cx}" y="${cy + 68}" text-anchor="middle" fill="${b.accent}" font-family="Plus Jakarta Sans, sans-serif" font-weight="800" font-size="30" letter-spacing="1">${b.num}</text>
          <text x="${cx}" y="${cy - 76}" text-anchor="middle" fill="rgba(255,255,255,0.88)" font-family="Plus Jakarta Sans, sans-serif" font-weight="700" font-size="13" letter-spacing="2.5">${b.name}</text>
          <ellipse cx="${cx - 34}" cy="${cy - 44}" rx="68" ry="26" transform="rotate(-28 ${cx - 34} ${cy - 44})" fill="rgba(255,255,255,0.22)"/>
        </g>
        <circle cx="${cx}" cy="${cy}" r="${r - 5}" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="2"/>
      </g>`;
    })
    .join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">
    <defs>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="8"/>
      </filter>
    </defs>
    <rect width="1200" height="900" fill="#ECEEF2"/>
    <rect x="28" y="28" width="1144" height="844" rx="18" fill="#F8F9FB" stroke="#E2E6EE" stroke-width="2"/>
    ${badgeSvgs}
  </svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function makeDemoMarketInfo(params: {
  median: number;
  low: number;
  high: number;
  count: number;
  cnTitle: string;
  cnPrice: number;
  jpTitle: string;
  jpyPrice: number;
  jpQuery: string;
  recentDate: string;
}): ItemMarketPriceInfo {
  const cnyFromJpy = Math.round(params.jpyPrice * 0.048 * 1.12 * 100) / 100;
  return {
    marketPriceMedian: params.median,
    marketPriceRange: [params.low, params.high],
    sampleCount: params.count,
    pricingTier: 'exact_market',
    freshness: 'fresh',
    queryUsed: params.jpQuery,
    sources: [
      {
        platform: '闲鱼',
        title: params.cnTitle,
        rawPrice: params.cnPrice,
        currency: 'CNY',
        cnyPrice: params.cnPrice,
        listedAt: params.recentDate,
        url: `https://www.goofish.com/search?q=${encodeURIComponent(params.cnTitle)}`,
        freshness: 'fresh',
        sold: true,
      },
      {
        platform: '煤炉 Mercari',
        title: params.jpTitle,
        rawPrice: params.jpyPrice,
        currency: 'JPY',
        cnyPrice: cnyFromJpy,
        listedAt: params.recentDate,
        url: `https://jp.mercari.com/search?keyword=${encodeURIComponent(params.jpQuery)}`,
        freshness: 'fresh',
        sold: true,
      },
    ],
  };
}

export function createSeedDemoProjects(): GachaProject[] {
  const now = new Date();
  const nowIso = now.toISOString();
  const recentDate = new Date(now.getTime() - 4 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  // Flagship Demo 1: Wide cold/hot spread (2.45x vs 0.36x -> >6x realistic spread) + traceable market samples
  const acrylicCost = {
    mode: 'direct' as const,
    targetTotal: 270,
    foreignPrice: 5200,
    exchangeRate: 0.048,
    shippingFee: 20,
    feeRate: 0.01,
    step: 1 as const,
    gamma: 1.0,
  };
  const acrylicRawItems = [
    {
      id: 'acr-1',
      x: 0.23,
      y: 0.42,
      box: [0.10, 0.12, 0.46, 0.34] as [number, number, number, number],
      label: '苍蓝剑士',
      seriesHint: '周年原画立牌',
      itemType: '立牌',
      jpKeywords: '幻境物語 蒼藍の剣士 アクリルスタンド',
      weight: 1.68,
      quantity: 1,
      price: 0,
      locked: false,
      tag: '捆1' as const,
      weightSource: 'market_lookup' as const,
      marketPrice: makeDemoMarketInfo({
        median: 68,
        low: 62,
        high: 75,
        count: 6,
        cnTitle: '幻境物语 周年原画立牌 苍蓝剑士 单出已拆仅摆',
        cnPrice: 68,
        jpTitle: '幻境物語 原画展 アクリルスタンド 蒼藍の剣士 単品',
        jpyPrice: 1280,
        jpQuery: '幻境物語 蒼藍の剣士 アクリルスタンド',
        recentDate,
      }),
    },
    {
      id: 'acr-2',
      x: 0.51,
      y: 0.42,
      box: [0.09, 0.41, 0.46, 0.61] as [number, number, number, number],
      label: '紫晶魔女',
      seriesHint: '周年原画立牌',
      itemType: '立牌',
      jpKeywords: '幻境物語 紫晶の魔女 アクリルスタンド',
      weight: 2.45,
      quantity: 1,
      price: 0,
      locked: false,
      tag: '热烫' as const,
      weightSource: 'market_lookup' as const,
      marketPrice: makeDemoMarketInfo({
        median: 98,
        low: 88,
        high: 112,
        count: 9,
        cnTitle: '幻境物语 紫晶魔女 周年原画立牌 全新未拆单出',
        cnPrice: 98,
        jpTitle: '紫晶の魔女 原画 アクリルスタンド 即購入OK',
        jpyPrice: 1850,
        jpQuery: '幻境物語 紫晶の魔女 アクリルスタンド',
        recentDate,
      }),
    },
    {
      id: 'acr-3',
      x: 0.77,
      y: 0.42,
      box: [0.09, 0.69, 0.46, 0.86] as [number, number, number, number],
      label: '翠影游侠',
      seriesHint: '周年原画立牌',
      itemType: '立牌',
      jpKeywords: '幻境物語 翠影レンジャー アクリルスタンド',
      weight: 0.36,
      quantity: 1,
      price: 0,
      locked: false,
      tag: '捆物' as const,
      weightSource: 'market_lookup' as const,
      marketPrice: makeDemoMarketInfo({
        median: 15,
        low: 12,
        high: 18,
        count: 5,
        cnTitle: '幻境物语 翠影游侠 原画立牌 好价清谷单出',
        cnPrice: 15,
        jpTitle: '翠影レンジャー アクリルスタンド 単品',
        jpyPrice: 300,
        jpQuery: '幻境物語 翠影レンジャー アクリルスタンド',
        recentDate,
      }),
    },
    {
      id: 'acr-4',
      x: 0.23,
      y: 0.87,
      box: [0.52, 0.12, 0.91, 0.34] as [number, number, number, number],
      label: '绯红骑士',
      seriesHint: '周年原画立牌',
      itemType: '立牌',
      jpKeywords: '幻境物語 緋紅の騎士 アクリルスタンド',
      weight: 0.92,
      quantity: 1,
      price: 0,
      locked: false,
      tag: '' as const,
      weightSource: 'market_lookup' as const,
      marketPrice: makeDemoMarketInfo({
        median: 38,
        low: 34,
        high: 43,
        count: 5,
        cnTitle: '幻境物语 绯红骑士 周年立牌 现货单出',
        cnPrice: 38,
        jpTitle: '緋紅の騎士 アクリルスタンド',
        jpyPrice: 720,
        jpQuery: '幻境物語 緋紅の騎士 アクリルスタンド',
        recentDate,
      }),
    },
    {
      id: 'acr-5',
      x: 0.51,
      y: 0.87,
      box: [0.52, 0.42, 0.91, 0.59] as [number, number, number, number],
      label: '圣洁祭司',
      seriesHint: '周年原画立牌',
      itemType: '立牌',
      jpKeywords: '幻境物語 聖潔の神官 アクリルスタンド',
      weight: 1.15,
      quantity: 1,
      price: 0,
      locked: false,
      tag: '' as const,
      weightSource: 'market_lookup' as const,
      marketPrice: makeDemoMarketInfo({
        median: 46,
        low: 42,
        high: 52,
        count: 7,
        cnTitle: '幻境物语 圣洁祭司 周年原画立牌 单出',
        cnPrice: 46,
        jpTitle: '聖潔の神官 アクリルスタンド 新品',
        jpyPrice: 880,
        jpQuery: '幻境物語 聖潔の神官 アクリルスタンド',
        recentDate,
      }),
    },
    {
      id: 'acr-6',
      x: 0.77,
      y: 0.87,
      box: [0.52, 0.68, 0.91, 0.86] as [number, number, number, number],
      label: '精灵射手',
      seriesHint: '周年原画立牌',
      itemType: '立牌',
      jpKeywords: '幻境物語 エルフの射手 アクリルスタンド',
      weight: 0.54,
      quantity: 1,
      price: 0,
      locked: false,
      tag: '捆物' as const,
      weightSource: 'market_lookup' as const,
      marketPrice: makeDemoMarketInfo({
        median: 22,
        low: 18,
        high: 26,
        count: 4,
        cnTitle: '幻境物语 精灵射手 立牌 可被捆单出',
        cnPrice: 22,
        jpTitle: 'エルフの射手 アクリルスタンド',
        jpyPrice: 420,
        jpQuery: '幻境物語 エルフの射手 アクリルスタンド',
        recentDate,
      }),
    },
  ];
  const acrylicRebalanced = rebalanceItems(
    acrylicRawItems,
    calcTargetTotal(acrylicCost),
    acrylicCost.step,
    acrylicCost.gamma
  );

  // Demo 2: 排球少年 8枚抱盒吧唧 (Foreign JPY mode + wide spread)
  const badgeCost = {
    mode: 'foreign' as const,
    targetTotal: 250,
    foreignPrice: 4400,
    exchangeRate: 0.048,
    shippingFee: 36,
    feeRate: 0.01,
    step: 1 as const,
    gamma: 1.0,
  };
  const badgeTarget = calcTargetTotal(badgeCost);
  const badgeRawItems = [
    {
      id: 'hq-1',
      x: 0.15,
      y: 0.37,
      box: [0.13, 0.05, 0.40, 0.25] as [number, number, number, number],
      label: '孤爪研磨',
      seriesHint: '猫乌垃圾场决战闪吧唧',
      itemType: '吧唧',
      jpKeywords: 'ハイキュー 孤爪研磨 缶バッジ',
      weight: 2.35,
      quantity: 1,
      price: 0,
      locked: false,
      tag: '热烫' as const,
      weightSource: 'market_lookup' as const,
      marketPrice: makeDemoMarketInfo({
        median: 72,
        low: 65,
        high: 82,
        count: 11,
        cnTitle: '排球少年 孤爪研磨 垃圾场决战吧唧 单出无瑕',
        cnPrice: 72,
        jpTitle: 'ハイキュー!! 孤爪研磨 缶バッジ ゴミ捨て場の決戦',
        jpyPrice: 1380,
        jpQuery: 'ハイキュー 孤爪研磨 缶バッジ',
        recentDate,
      }),
    },
    {
      id: 'hq-2',
      x: 0.383,
      y: 0.37,
      box: [0.13, 0.28, 0.40, 0.49] as [number, number, number, number],
      label: '黑尾铁朗',
      seriesHint: '猫乌垃圾场决战闪吧唧',
      itemType: '吧唧',
      jpKeywords: 'ハイキュー 黒尾鉄朗 缶バッジ',
      weight: 1.78,
      quantity: 1,
      price: 0,
      locked: false,
      tag: '捆1' as const,
      weightSource: 'market_lookup' as const,
      marketPrice: makeDemoMarketInfo({
        median: 55,
        low: 48,
        high: 62,
        count: 8,
        cnTitle: '排球少年 黑尾铁朗 闪吧唧 单出',
        cnPrice: 55,
        jpTitle: 'ハイキュー 黒尾鉄朗 缶バッジ 単品',
        jpyPrice: 1050,
        jpQuery: 'ハイキュー 黒尾鉄朗 缶バッジ',
        recentDate,
      }),
    },
    { id: 'hq-3', x: 0.616, y: 0.37, box: [0.13, 0.51, 0.40, 0.72] as [number, number, number, number], label: '及川彻', seriesHint: '猫乌联名吧唧', itemType: '吧唧', jpKeywords: 'ハイキュー 及川徹 缶バッジ', weight: 1.86, quantity: 1, price: 0, locked: false, tag: '捆1' as const, weightSource: 'market_db' as const },
    { id: 'hq-4', x: 0.85, y: 0.37, box: [0.13, 0.75, 0.40, 0.95] as [number, number, number, number], label: '日向翔阳', seriesHint: '猫乌联名吧唧', itemType: '吧唧', jpKeywords: 'ハイキュー 日向翔陽 缶バッジ', weight: 1.22, quantity: 1, price: 0, locked: false, tag: '' as const, weightSource: 'market_db' as const },
    { id: 'hq-5', x: 0.15, y: 0.83, box: [0.59, 0.05, 0.86, 0.25] as [number, number, number, number], label: '影山飞雄', seriesHint: '猫乌联名吧唧', itemType: '吧唧', jpKeywords: 'ハイキュー 影山飛雄 缶バッジ', weight: 1.28, quantity: 1, price: 0, locked: false, tag: '' as const, weightSource: 'market_db' as const },
    { id: 'hq-6', x: 0.383, y: 0.83, box: [0.59, 0.28, 0.86, 0.49] as [number, number, number, number], label: '月岛萤', seriesHint: '猫乌联名吧唧', itemType: '吧唧', jpKeywords: 'ハイキュー 月島蛍 缶バッジ', weight: 1.12, quantity: 1, price: 0, locked: false, tag: '' as const, weightSource: 'market_db' as const },
    { id: 'hq-7', x: 0.616, y: 0.83, box: [0.59, 0.51, 0.86, 0.72] as [number, number, number, number], label: '夜久卫辅', seriesHint: '猫乌联名吧唧', itemType: '吧唧', jpKeywords: 'ハイキュー 夜久衛輔 缶バッジ', weight: 0.62, quantity: 1, price: 0, locked: false, tag: '捆物' as const, weightSource: 'market_db' as const },
    { id: 'hq-8', x: 0.85, y: 0.83, box: [0.59, 0.75, 0.86, 0.95] as [number, number, number, number], label: '犬冈走', seriesHint: '猫乌联名吧唧', itemType: '吧唧', jpKeywords: 'ハイキュー 犬岡走 缶バッジ', weight: 0.35, quantity: 1, price: 0, locked: false, tag: '捆物' as const, weightSource: 'market_db' as const },
  ];
  const badgeRebalanced = rebalanceItems(badgeRawItems, badgeTarget, badgeCost.step, badgeCost.gamma);
  const badgeImgUrl = buildBadgeSheetDataUrl();

  return [
    {
      version: 1,
      id: 'demo-acrylic-standees-01',
      name: '幻境冒险 6枚抱盒立牌',
      ipName: '幻境物语',
      category: '立牌',
      updatedAt: nowIso,
      naturalWidth: 1200,
      naturalHeight: 900,
      imageDataUrl: '/src/assets/images/demo_acrylic_stands_1795441637715.jpg',
      thumbDataUrl: '/src/assets/images/demo_acrylic_stands_1795441637715.jpg',
      cost: acrylicCost,
      items: acrylicRebalanced.items,
    },
    {
      version: 1,
      id: 'demo-haikyuu-badges-02',
      name: '猫乌联名 8枚抱盒吧唧',
      ipName: '排球少年',
      category: '吧唧',
      updatedAt: new Date(now.getTime() - 3600 * 1000).toISOString(),
      naturalWidth: 1200,
      naturalHeight: 900,
      imageDataUrl: badgeImgUrl,
      thumbDataUrl: badgeImgUrl,
      cost: { ...badgeCost, targetTotal: badgeTarget },
      items: badgeRebalanced.items,
    },
  ];
}
