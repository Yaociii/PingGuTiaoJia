import type { GoodItem, GroupOrderDetail } from '../types/pricing';
import { formatMoney } from './rebalancer';

export type GroupTemplatePresetId = 'miniapp_batch' | 'chat_solitaire' | 'custom';

export interface GroupExportRow {
  label: string;
  price: number;
  quantity: number;
  tag: string;
  note: string;
}

export const TEMPLATE_PRESETS: Record<
  Exclude<GroupTemplatePresetId, 'custom'>,
  { name: string; description: string; lineTemplate: string; includeHeaderFooter: boolean }
> = {
  miniapp_batch: {
    name: '小程序批量识别格式',
    description: '适配快团团 / 拼谷助手等小程序文本一键粘贴建团',
    lineTemplate: '{{label}} {{price}}*{{quantity}} [{{tag}}]',
    includeHeaderFooter: false,
  },
  chat_solitaire: {
    name: 'QQ / 微信群排表接龙公告',
    description: '带团头、余量与排谷规则，直接发群开启接龙',
    lineTemplate: '· {{label}}：¥{{price}}（共{{quantity}}件）[{{tag}}]',
    includeHeaderFooter: true,
  },
};

/**
 * 防止 CSV / Excel 公式注入：若文本以 = + - @ \t \r 开头，前置单引号转义
 */
export function sanitizeSpreadsheetCellText(raw: string): string {
  const clean = (raw || '').replace(/\r?\n/g, ' ').trim();
  if (/^[=+\-@\t\r]/.test(clean)) {
    return `'${clean}`;
  }
  return clean;
}

export function buildGroupExportRows(
  items: GoodItem[],
  ipName = ''
): GroupExportRow[] {
  return items
    .filter((it) => it.quantity > 0 && it.tag !== '自留')
    .map((it) => {
      const noteParts: string[] = [];
      if (ipName.trim()) noteParts.push(ipName.trim());
      if (it.seriesHint?.trim()) noteParts.push(it.seriesHint.trim());
      if (it.marketPrice?.marketPriceMedian) {
        noteParts.push(`参考市价¥${formatMoney(it.marketPrice.marketPriceMedian)}`);
      }
      return {
        label: sanitizeSpreadsheetCellText(it.label || '未命名'),
        price: Math.round(Math.max(0, it.price) * 100) / 100,
        quantity: Math.max(1, Math.floor(it.quantity)),
        tag: sanitizeSpreadsheetCellText(it.tag || ''),
        note: sanitizeSpreadsheetCellText(noteParts.join(' · ')),
      };
    });
}

function escapeCsvField(val: string | number): string {
  const str = String(val);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * 生成带 UTF-8 BOM 的标准 CSV 表格文本（Excel 双击直接打开不乱码）
 * 列头：商品名称/角色, 单价, 总数量, 捆绑/标签, 备注
 */
export function buildGroupCsvContent(
  items: GoodItem[],
  ipName = ''
): string {
  const rows = buildGroupExportRows(items, ipName);
  const header = ['商品名称/角色', '单价', '总数量', '捆绑/标签', '备注'];
  const lines = [header.map(escapeCsvField).join(',')];
  for (const r of rows) {
    lines.push(
      [
        escapeCsvField(r.label),
        escapeCsvField(r.price),
        escapeCsvField(r.quantity),
        escapeCsvField(r.tag),
        escapeCsvField(r.note),
      ].join(',')
    );
  }
  return `\uFEFF${lines.join('\r\n')}`;
}

/**
 * 渲染单行拼谷模板，支持 {{label}} {{price}} {{quantity}} {{tag}}
 */
export function renderSingleTemplateLine(lineTemplate: string, item: GoodItem): string {
  const tagVal = (item.tag || '').trim();
  let out = lineTemplate;

  // Cleanly handle bracketed or parenthesized {{tag}} when tag is empty
  if (!tagVal) {
    out = out
      .replace(/\s*\[{{\s*tag\s*}}\]/g, '')
      .replace(/\s*【{{\s*tag\s*}}】/g, '')
      .replace(/\s*\({{\s*tag\s*}}\)/g, '')
      .replace(/\s*（{{\s*tag\s*}}）/g, '');
  }

  out = out
    .replace(/{{\s*label\s*}}/g, (item.label || '未命名').trim())
    .replace(/{{\s*price\s*}}/g, formatMoney(item.price))
    .replace(/{{\s*quantity\s*}}/g, String(Math.max(0, Math.floor(item.quantity))))
    .replace(/{{\s*tag\s*}}/g, tagVal);

  return out.replace(/[ \t]+$/g, '').replace(/ {2,}/g, ' ');
}

/**
 * 渲染整团多格式复制文本
 */
export function renderGroupTemplateText(params: {
  projectName: string;
  ipName?: string;
  items: GoodItem[];
  lineTemplate: string;
  includeHeaderFooter?: boolean;
}): string {
  const activeItems = params.items.filter((it) => it.quantity > 0 && it.tag !== '自留');
  const bodyLines = activeItems.map((it) => renderSingleTemplateLine(params.lineTemplate, it));

  if (!params.includeHeaderFooter) {
    return bodyLines.join('\n');
  }

  const headerTitle = params.ipName?.trim()
    ? `【${params.ipName.trim()} · ${params.projectName} 开团排表】`
    : `【${params.projectName} 开团排表】`;
  const selfKept = params.items
    .filter((it) => it.quantity > 0 && it.tag === '自留')
    .map((it) => it.label);

  const lines: string[] = [headerTitle];
  lines.push(...bodyLines);
  if (selfKept.length > 0) {
    lines.push(`（团长自留：${selfKept.join('、')}）`);
  }
  lines.push('------------------------');
  lines.push('排谷方式：群内直接回复「角色名 + 数量」，热烫款式请按标注配合带捆，成团后统一通知肾款。');
  return lines.join('\n');
}

/**
 * 生成在线拼团「分人肾表」汇总文本（含盲抽二调退补差额）
 */
export function buildBuyerBillsSummaryText(order: GroupOrderDetail): string {
  const lines: string[] = [];
  lines.push(`【${order.title}${order.ipName ? ` · ${order.ipName}` : ''} 分人肾表】`);
  if (order.buyerBills.length === 0) {
    lines.push('暂无团员认领记录。');
    return lines.join('\n');
  }

  let grandTotal = 0;
  for (const bill of order.buyerBills) {
    grandTotal += bill.totalAmount;
    const itemDesc = bill.items
      .map((it) => `${it.label}×${it.qty}(¥${formatMoney(it.unitPrice)})`)
      .join(' + ');
    const deltaNote =
      Math.abs(bill.deltaTotal) >= 0.01
        ? bill.deltaTotal > 0
          ? ` ｜ 二调需补 +¥${formatMoney(bill.deltaTotal)}`
          : ` ｜ 二调应退 -¥${formatMoney(Math.abs(bill.deltaTotal))}`
        : '';
    lines.push(
      `@${bill.buyerName}（${bill.buyerContact}）：共 ${bill.totalQty} 件，应付 ¥${formatMoney(bill.totalAmount)}${deltaNote} 明细：${itemDesc}`
    );
  }
  lines.push('------------------------');
  lines.push(`肾表应收总计：¥${formatMoney(grandTotal)}（共 ${order.buyerBills.length} 位团员）`);
  return lines.join('\n');
}

// ============================================================================
// Pure Standards-Compliant OOXML (.xlsx) Generator (Zero External Dependencies)
// ============================================================================

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16LE(buf: Uint8Array, offset: number, val: number): void {
  buf[offset] = val & 0xff;
  buf[offset + 1] = (val >>> 8) & 0xff;
}

function writeUint32LE(buf: Uint8Array, offset: number, val: number): void {
  buf[offset] = val & 0xff;
  buf[offset + 1] = (val >>> 8) & 0xff;
  buf[offset + 2] = (val >>> 16) & 0xff;
  buf[offset + 3] = (val >>> 24) & 0xff;
}

function createStoredZip(files: Array<{ path: string; content: string }>): Uint8Array {
  const encoder = new TextEncoder();
  const entries = files.map((f) => {
    const nameBytes = encoder.encode(f.path);
    const dataBytes = encoder.encode(f.content);
    return {
      nameBytes,
      dataBytes,
      crc: crc32(dataBytes),
      offset: 0,
    };
  });

  let localSize = 0;
  let centralSize = 0;
  for (const e of entries) {
    e.offset = localSize;
    localSize += 30 + e.nameBytes.length + e.dataBytes.length;
    centralSize += 46 + e.nameBytes.length;
  }

  const totalSize = localSize + centralSize + 22;
  const out = new Uint8Array(totalSize);
  let pos = 0;

  // Local file headers + data
  for (const e of entries) {
    writeUint32LE(out, pos, 0x04034b50); // Local file header signature
    writeUint16LE(out, pos + 4, 20); // Version needed to extract (2.0)
    writeUint16LE(out, pos + 6, 0x0800); // UTF-8 filename flag
    writeUint16LE(out, pos + 8, 0); // Compression method 0 = stored
    writeUint16LE(out, pos + 10, 0); // Mod time
    writeUint16LE(out, pos + 12, 0x21); // Mod date
    writeUint32LE(out, pos + 14, e.crc);
    writeUint32LE(out, pos + 18, e.dataBytes.length);
    writeUint32LE(out, pos + 22, e.dataBytes.length);
    writeUint16LE(out, pos + 26, e.nameBytes.length);
    writeUint16LE(out, pos + 28, 0);
    pos += 30;
    out.set(e.nameBytes, pos);
    pos += e.nameBytes.length;
    out.set(e.dataBytes, pos);
    pos += e.dataBytes.length;
  }

  const centralDirOffset = pos;

  // Central directory headers
  for (const e of entries) {
    writeUint32LE(out, pos, 0x02014b50);
    writeUint16LE(out, pos + 4, 20);
    writeUint16LE(out, pos + 6, 20);
    writeUint16LE(out, pos + 8, 0x0800);
    writeUint16LE(out, pos + 10, 0);
    writeUint16LE(out, pos + 12, 0);
    writeUint16LE(out, pos + 14, 0x21);
    writeUint32LE(out, pos + 16, e.crc);
    writeUint32LE(out, pos + 20, e.dataBytes.length);
    writeUint32LE(out, pos + 24, e.dataBytes.length);
    writeUint16LE(out, pos + 28, e.nameBytes.length);
    writeUint16LE(out, pos + 30, 0);
    writeUint16LE(out, pos + 32, 0);
    writeUint16LE(out, pos + 34, 0);
    writeUint16LE(out, pos + 36, 0);
    writeUint32LE(out, pos + 38, 0);
    writeUint32LE(out, pos + 42, e.offset);
    pos += 46;
    out.set(e.nameBytes, pos);
    pos += e.nameBytes.length;
  }

  // End of Central Directory Record (EOCD)
  writeUint32LE(out, pos, 0x06054b50);
  writeUint16LE(out, pos + 4, 0);
  writeUint16LE(out, pos + 6, 0);
  writeUint16LE(out, pos + 8, entries.length);
  writeUint16LE(out, pos + 10, entries.length);
  writeUint32LE(out, pos + 12, centralSize);
  writeUint32LE(out, pos + 16, centralDirOffset);
  writeUint16LE(out, pos + 20, 0);

  return out;
}

function buildSheetXml(rows: GroupExportRow[]): string {
  const xmlRows: string[] = [];

  // Row 1: Header
  const headers = ['商品名称/角色', '单价', '总数量', '捆绑/标签', '备注'];
  const colLetters = ['A', 'B', 'C', 'D', 'E'];
  const headerCells = headers
    .map(
      (h, idx) =>
        `<c r="${colLetters[idx]}1" t="inlineStr"><is><t>${escapeXml(h)}</t></is></c>`
    )
    .join('');
  xmlRows.push(`<row r="1">${headerCells}</row>`);

  // Data rows
  rows.forEach((r, i) => {
    const rowNum = i + 2;
    const cells = [
      `<c r="A${rowNum}" t="inlineStr"><is><t>${escapeXml(r.label)}</t></is></c>`,
      `<c r="B${rowNum}"><v>${r.price}</v></c>`,
      `<c r="C${rowNum}"><v>${r.quantity}</v></c>`,
      `<c r="D${rowNum}" t="inlineStr"><is><t>${escapeXml(r.tag)}</t></is></c>`,
      `<c r="E${rowNum}" t="inlineStr"><is><t>${escapeXml(r.note)}</t></is></c>`,
    ].join('');
    xmlRows.push(`<row r="${rowNum}">${cells}</row>`);
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cols>
    <col min="1" max="1" width="22" customWidth="1"/>
    <col min="2" max="3" width="12" customWidth="1"/>
    <col min="4" max="4" width="14" customWidth="1"/>
    <col min="5" max="5" width="32" customWidth="1"/>
  </cols>
  <sheetData>${xmlRows.join('')}</sheetData>
</worksheet>`;
}

/**
 * 构建标准 Excel (.xlsx) 二进制字节流（可在 Node 测试和浏览器 Blob 下载中通用）
 */
export function buildGroupXlsxBytes(items: GoodItem[], ipName = ''): Uint8Array {
  const rows = buildGroupExportRows(items, ipName);
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="拼团商品清单" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`;

  return createStoredZip([
    { path: '[Content_Types].xml', content: contentTypes },
    { path: '_rels/.rels', content: rootRels },
    { path: 'xl/workbook.xml', content: workbookXml },
    { path: 'xl/_rels/workbook.xml.rels', content: workbookRels },
    { path: 'xl/styles.xml', content: stylesXml },
    { path: 'xl/worksheets/sheet1.xml', content: buildSheetXml(rows) },
  ]);
}

export function buildGroupXlsxBlob(items: GoodItem[], ipName = ''): Blob {
  const bytes = buildGroupXlsxBytes(items, ipName);
  return new Blob([bytes.buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
