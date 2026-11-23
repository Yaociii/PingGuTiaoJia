import type { ExportConfig, GachaProject, GoodItem, RebalanceResult } from '../types/pricing';
import { calcEffectiveAvgPrice, formatMoney } from './rebalancer';

export function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('无法加载原图，请检查图片数据是否有效。'));
    img.src = src;
  });
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

export function getPriceTemperature(
  price: number,
  avgPrice: number,
  quantity: number
): 'hot' | 'cold' | 'neutral' | 'zero' {
  if (quantity <= 0) return 'zero';
  if (avgPrice <= 0) return 'neutral';
  if (price >= avgPrice * 1.08) return 'hot';
  if (price <= avgPrice * 0.92) return 'cold';
  return 'neutral';
}

/**
 * 离屏无损高清渲染：原图 naturalWidth × (naturalHeight + footerHeight)
 * 绘制冷热色标价格胶囊 + 底部深色平账校验条
 */
export async function renderAnnotatedCanvas(
  project: GachaProject,
  rebalance: RebalanceResult,
  exportConfig: ExportConfig
): Promise<HTMLCanvasElement> {
  const img = await loadImageElement(project.imageDataUrl);
  const w = img.naturalWidth || project.naturalWidth || 1200;
  const h = img.naturalHeight || project.naturalHeight || 900;
  const shortSide = Math.min(w, h);
  const footerHeight = Math.max(68, Math.round(shortSide * 0.088));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h + footerHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器不支持 Canvas 2D 渲染。');

  // 1. Draw lossless original image
  ctx.drawImage(img, 0, 0, w, h);

  // 2. Render each price capsule
  const avgPrice = calcEffectiveAvgPrice(rebalance.items);
  const scale = Math.min(1.4, Math.max(0.8, exportConfig.scale || 1));
  const baseFontSize = Math.max(15, Math.round(shortSide * 0.026 * scale));
  const tagFontSize = Math.max(12, Math.round(baseFontSize * 0.72));
  const padX = Math.round(baseFontSize * 0.62);
  const padY = Math.round(baseFontSize * 0.34);

  for (const item of rebalance.items) {
    const cx = Math.round(item.x * w);
    const cy = Math.round(item.y * h);
    const temp = getPriceTemperature(item.price, avgPrice, item.quantity);

    const priceText = item.quantity <= 0 ? '未出' : `¥${formatMoney(item.price)}`;
    const qtySuffix = item.quantity > 1 ? ` ×${item.quantity}` : '';
    const mainText =
      exportConfig.displayMode === 'label_and_price' && item.label
        ? `${item.label} ${priceText}${qtySuffix}`
        : `${priceText}${qtySuffix}`;

    const showTag = exportConfig.showTag && Boolean(item.tag) && item.quantity > 0;

    ctx.font = `700 ${baseFontSize}px "Plus Jakarta Sans", "Noto Sans SC", sans-serif`;
    const mainWidth = ctx.measureText(mainText).width;

    let tagWidth = 0;
    const tagPadX = Math.round(tagFontSize * 0.48);
    const tagGap = showTag ? Math.round(baseFontSize * 0.35) : 0;
    if (showTag) {
      ctx.font = `700 ${tagFontSize}px "Plus Jakarta Sans", "Noto Sans SC", sans-serif`;
      tagWidth = ctx.measureText(item.tag).width + tagPadX * 2;
    }

    const boxW = Math.ceil(padX * 2 + mainWidth + tagGap + tagWidth);
    const boxH = Math.ceil(baseFontSize + padY * 2);

    // Clamp capsule strictly inside image bounds
    const left = Math.max(8, Math.min(w - boxW - 8, Math.round(cx - boxW / 2)));
    const top = Math.max(8, Math.min(h - boxH - 8, Math.round(cy - boxH / 2)));

    // Palette by hot/cold/neutral temperature
    let bgColor = '#FFFFFF';
    let textColor = '#111827';
    let borderColor = 'rgba(17, 24, 39, 0.22)';
    let tagBg = '#F3F4F6';
    let tagText = '#374151';

    if (temp === 'hot') {
      bgColor = '#E11D48';
      textColor = '#FFFFFF';
      borderColor = 'rgba(255, 255, 255, 0.45)';
      tagBg = 'rgba(0, 0, 0, 0.22)';
      tagText = '#FFFFFF';
    } else if (temp === 'cold') {
      bgColor = '#2563EB';
      textColor = '#FFFFFF';
      borderColor = 'rgba(255, 255, 255, 0.45)';
      tagBg = 'rgba(0, 0, 0, 0.22)';
      tagText = '#FFFFFF';
    } else if (temp === 'zero') {
      bgColor = '#4B5563';
      textColor = '#E5E7EB';
      borderColor = 'rgba(255, 255, 255, 0.35)';
    }

    ctx.save();
    ctx.shadowColor = 'rgba(15, 23, 42, 0.28)';
    ctx.shadowBlur = Math.max(8, Math.round(baseFontSize * 0.45));
    ctx.shadowOffsetY = Math.max(2, Math.round(baseFontSize * 0.14));

    drawRoundedRect(ctx, left, top, boxW, boxH, boxH / 2);
    ctx.fillStyle = bgColor;
    ctx.fill();
    ctx.restore();

    drawRoundedRect(ctx, left, top, boxW, boxH, boxH / 2);
    ctx.lineWidth = Math.max(1.5, Math.round(shortSide * 0.002));
    ctx.strokeStyle = borderColor;
    ctx.stroke();

    // Draw main price/label text
    ctx.font = `700 ${baseFontSize}px "Plus Jakarta Sans", "Noto Sans SC", sans-serif`;
    ctx.fillStyle = textColor;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(mainText, left + padX, top + boxH / 2 + 1);

    // Draw optional Tag pill inside capsule
    if (showTag) {
      const tagX = left + padX + mainWidth + tagGap;
      const tagH = Math.round(tagFontSize * 1.45);
      const tagY = top + (boxH - tagH) / 2;
      drawRoundedRect(ctx, tagX, tagY, tagWidth, tagH, tagH / 2);
      ctx.fillStyle = tagBg;
      ctx.fill();

      ctx.font = `700 ${tagFontSize}px "Plus Jakarta Sans", "Noto Sans SC", sans-serif`;
      ctx.fillStyle = tagText;
      ctx.textAlign = 'center';
      ctx.fillText(item.tag, tagX + tagWidth / 2, tagY + tagH / 2 + 0.5);
    }
  }

  // 3. Draw dark reconciliation footer bar
  ctx.fillStyle = '#0F172A';
  ctx.fillRect(0, h, w, footerHeight);

  // Subtle top border line separating image & footer
  ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.fillRect(0, h, w, 1.5);

  const footerPadX = Math.max(20, Math.round(w * 0.025));
  const titleFontSize = Math.max(15, Math.round(footerHeight * 0.28));
  const metaFontSize = Math.max(12, Math.round(footerHeight * 0.21));
  const validQty = rebalance.items.reduce((sum, it) => sum + (it.quantity > 0 ? it.quantity : 0), 0);

  // Left: Project / IP title + summary line
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${titleFontSize}px "Plus Jakarta Sans", "Noto Sans SC", sans-serif`;
  ctx.fillStyle = '#F8FAFC';
  const leftTitle = project.ipName ? `${project.ipName} · ${project.name}` : project.name;
  ctx.fillText(leftTitle, footerPadX, h + footerHeight * 0.36);

  ctx.font = `500 ${metaFontSize}px "JetBrains Mono", "Noto Sans SC", monospace`;
  ctx.fillStyle = '#94A3B8';
  ctx.fillText(
    `有效 ${validQty} 件 · 预期总价 ¥${formatMoney(rebalance.targetTotal)} · 当前标注合计 ¥${formatMoney(rebalance.actualTotal)}`,
    footerPadX,
    h + footerHeight * 0.72
  );

  // Right: Balance verification badge
  let badgeText = '✓ 严丝合缝';
  let badgeBg = '#059669';
  if (rebalance.status === 'LOCKED_EXCEEDS_TARGET') {
    badgeText = `⚠ 锁定超额 +¥${formatMoney(rebalance.exceedAmount)}`;
    badgeBg = '#DC2626';
  } else if (rebalance.status === 'RESIDUAL_NONZERO' || rebalance.status === 'NO_UNLOCKED_ITEMS') {
    const sign = rebalance.residual > 0 ? '+' : '';
    badgeText = `⚠ 余差 ${sign}¥${formatMoney(rebalance.residual)}`;
    badgeBg = '#D97706';
  }

  ctx.font = `700 ${metaFontSize}px "Plus Jakarta Sans", "Noto Sans SC", sans-serif`;
  const badgeTextW = ctx.measureText(badgeText).width;
  const badgePadX = Math.round(metaFontSize * 0.85);
  const badgeW = Math.ceil(badgeTextW + badgePadX * 2);
  const badgeH = Math.round(footerHeight * 0.48);
  const badgeX = w - footerPadX - badgeW;
  const badgeY = h + Math.round((footerHeight - badgeH) / 2);

  drawRoundedRect(ctx, badgeX, badgeY, badgeW, badgeH, 8);
  ctx.fillStyle = badgeBg;
  ctx.fill();

  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(badgeText, badgeX + badgeW / 2, badgeY + badgeH / 2 + 0.5);

  return canvas;
}

/**
 * 单谷快捷裁图（用于发去二手平台/群里查价）：
 * - 若有 box：向外扩 4% 留白裁剪
 * - 若无 box：以 (x, y) 为中心裁剪原图短边 22% 的正方形区域
 */
export async function cropSingleItemToBlob(
  imageDataUrl: string,
  item: GoodItem
): Promise<Blob> {
  const img = await loadImageElement(imageDataUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;

  let sx: number;
  let sy: number;
  let sw: number;
  let sh: number;

  if (item.box) {
    const [ymin, xmin, ymax, xmax] = item.box;
    const bw = xmax - xmin;
    const bh = ymax - ymin;
    const padX = bw * 0.04;
    const padY = bh * 0.04;
    const nx1 = Math.max(0, xmin - padX);
    const ny1 = Math.max(0, ymin - padY);
    const nx2 = Math.min(1, xmax + padX);
    const ny2 = Math.min(1, ymax + padY);
    sx = Math.round(nx1 * w);
    sy = Math.round(ny1 * h);
    sw = Math.max(16, Math.round((nx2 - nx1) * w));
    sh = Math.max(16, Math.round((ny2 - ny1) * h));
  } else {
    const side = Math.round(Math.min(w, h) * 0.22);
    const half = Math.round(side / 2);
    sx = Math.max(0, Math.min(w - side, Math.round(item.x * w) - half));
    sy = Math.max(0, Math.min(h - side, Math.round(item.y * h) - half));
    sw = Math.min(side, w - sx);
    sh = Math.min(side, h - sy);
  }

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建裁剪画布。');
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

  return canvasToPngBlob(canvas);
}

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('PNG 图像编码失败。'));
    }, 'image/png');
  });
}

export async function createThumbnailDataUrl(imageDataUrl: string, maxWidth = 320): Promise<string> {
  const img = await loadImageElement(imageDataUrl);
  const scale = Math.min(1, maxWidth / Math.max(1, img.naturalWidth));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return imageDataUrl;
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.82);
}

/**
 * 将图片压缩为长边 <= 1280px 的 JPEG Blob 供后端 VLM 识图使用
 */
export async function prepareImageBlobForDetect(imageDataUrl: string): Promise<Blob> {
  const img = await loadImageElement(imageDataUrl);
  const maxDim = 1280;
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('画布初始化失败。');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('图片预处理失败。'));
      },
      'image/jpeg',
      0.88
    );
  });
}

export async function copyPngBlobToClipboard(blob: Blob): Promise<'copied' | 'fallback'> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof ClipboardItem !== 'undefined') {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return 'copied';
    } catch {
      return 'fallback';
    }
  }
  return 'fallback';
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
