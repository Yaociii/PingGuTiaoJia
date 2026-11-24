import type { NormalizedVlmItem, ParsedVlmResponse, RawVlmItem } from './types';

export const VLM_WEIGHT_MIN = 0.1;
export const VLM_WEIGHT_MAX = 10.0;

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

function round4(val: number): number {
  return Math.round(val * 10000) / 10000;
}

/**
 * 清洗 VLM 可能返回的脏 JSON：
 * 1. 剥离 Markdown 代码围栏 (```json ... ```)
 * 2. 截取最外层 { ... }
 * 3. 清除数组或对象末尾非法尾逗号
 */
export function cleanDirtyJson(rawText: string): string {
  let text = rawText.trim();

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    text = fenceMatch[1].trim();
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }

  text = text.replace(/,\s*([}\]])/g, '$1');

  return text;
}

/**
 * 将检测框归一化到 [0, 1] 坐标系，并计算防挡脸默认锚点
 */
export function normalizeVlmBox(
  rawBox: unknown,
  imgWidth = 1000,
  imgHeight = 1000
): { box: [number, number, number, number]; x: number; y: number } | null {
  if (!Array.isArray(rawBox) || rawBox.length !== 4) return null;
  const nums = rawBox.map((v) => Number(v));
  if (nums.some((n) => !Number.isFinite(n))) return null;

  const maxCoord = Math.max(...nums.map((n) => Math.abs(n)));
  let [ymin, xmin, ymax, xmax] = nums;

  if (maxCoord > 1000) {
    const safeH = Math.max(1, imgHeight);
    const safeW = Math.max(1, imgWidth);
    ymin /= safeH;
    ymax /= safeH;
    xmin /= safeW;
    xmax /= safeW;
  } else if (maxCoord > 1.0) {
    ymin /= 1000;
    xmin /= 1000;
    ymax /= 1000;
    xmax /= 1000;
  }

  if (ymin > ymax) [ymin, ymax] = [ymax, ymin];
  if (xmin > xmax) [xmin, xmax] = [xmax, xmin];

  ymin = clamp(ymin, 0, 1);
  xmin = clamp(xmin, 0, 1);
  ymax = clamp(ymax, 0, 1);
  xmax = clamp(xmax, 0, 1);

  const area = (ymax - ymin) * (xmax - xmin);
  if (area < 0.001) return null;

  const x = round4(clamp((xmin + xmax) / 2, 0.03, 0.97));
  const y = round4(clamp(ymin + (ymax - ymin) * 0.85, 0.05, 0.96));

  return {
    box: [round4(ymin), round4(xmin), round4(ymax), round4(xmax)],
    x,
    y,
  };
}

/**
 * V2.0 解析并规范化 VLM 响应 JSON：
 * - 提取顶层及单品级 series_hint、item_type、jp_keywords
 * - 权重放宽至 [0.1, 10.0]（支持 5x ~ 10x 真实谷圈价差）
 */
export function parseVlmResponseText(
  rawText: string,
  fallbackIpHint = '',
  imgWidth = 1000,
  imgHeight = 1000
): ParsedVlmResponse {
  const cleaned = cleanDirtyJson(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`模型返回内容无法解析为合法 JSON: ${(err as Error).message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('模型返回结果格式异常（非 JSON 对象）');
  }

  const record = parsed as Record<string, unknown>;
  const ipName =
    typeof record.ip_name === 'string' && record.ip_name.trim()
      ? record.ip_name.trim().slice(0, 60)
      : fallbackIpHint.trim().slice(0, 60) || '未识别作品';

  const topSeriesHint =
    typeof record.series_hint === 'string' ? record.series_hint.trim().slice(0, 48) : '';
  const topItemType =
    typeof record.item_type === 'string' ? record.item_type.trim().slice(0, 24) : '';

  const rawItems = Array.isArray(record.items) ? (record.items as RawVlmItem[]) : [];
  const items: NormalizedVlmItem[] = [];

  for (let i = 0; i < rawItems.length; i++) {
    const raw = rawItems[i];
    if (!raw || typeof raw !== 'object') continue;
    const normalizedGeo = normalizeVlmBox(raw.box, imgWidth, imgHeight);
    if (!normalizedGeo) continue;

    const rawLabel = typeof raw.label === 'string' ? raw.label.trim() : '';
    const label = rawLabel ? rawLabel.slice(0, 24) : `谷子${items.length + 1}`;

    const series_hint =
      typeof raw.series_hint === 'string' && raw.series_hint.trim()
        ? raw.series_hint.trim().slice(0, 48)
        : topSeriesHint;
    const item_type =
      typeof raw.item_type === 'string' && raw.item_type.trim()
        ? raw.item_type.trim().slice(0, 24)
        : topItemType || '通用';
    const jp_keywords =
      typeof raw.jp_keywords === 'string' ? raw.jp_keywords.trim().slice(0, 80) : '';

    const rawWeight = Number(raw.weight);
    const weight = Number.isFinite(rawWeight)
      ? clamp(Math.round(rawWeight * 100) / 100, VLM_WEIGHT_MIN, VLM_WEIGHT_MAX)
      : 1.0;

    items.push({
      label,
      series_hint,
      item_type,
      jp_keywords,
      box: normalizedGeo.box,
      x: normalizedGeo.x,
      y: normalizedGeo.y,
      weight,
    });
  }

  return { ip_name: ipName, series_hint: topSeriesHint, items };
}

/**
 * V2.0 VLM 结构化识图 Prompt 模板：
 * 输出 ip_name / series_hint / item_type / jp_keywords + 5档宽幅权重 (0.15 ~ 6.0)
 */
export function buildVlmDetectPrompt(ipHint?: string): string {
  const hintText = ipHint?.trim() || '无';
  return `你是一位精通二次元谷子（徽章/吧唧、立牌、色纸、拍立得、挂件、盲抽周边）拼团与煤炉/闲鱼市价行情的资深团长。
请识别图中每一个独立的周边商品单品，输出严格的 JSON 对象，不要包含任何多余解释或 Markdown 标记。

要求：
1. 识别作品 IP 的中文常用名（如用户提供了提示“${hintText}”请优先参考），并给出整图谷子系列/柄图特征 series_hint（如“原画展吧唧”、“咖啡厅立牌”、“一番赏色纸”）以及主要品类 item_type（吧唧/立牌/色纸/拍立得/挂件/盲盒/通用）。
2. 为每个独立谷子给出：
   - label：角色中文俗称或款式简称（2~8字）
   - series_hint：该款谷子的系列或柄图特征
   - item_type：品类
   - jp_keywords：用于检索日本煤炉（Mercari JP）的精准日文关键词，格式为「作品日文原名 + 角色日文名 + 品类日文词」（例如 "ハイキュー 孤爪研磨 缶バッジ"）
   - box：检测框坐标 [ymin, xmin, ymax, xmax]，严格采用 0~1000 整数坐标系
   - weight：按真实谷圈冷烫梯度给出的权重（基准均价 1.0，允许拉开 5~10 倍真实价差）：
     · 现象级顶流 / 隐藏款：3.0 ~ 6.0
     · 热门主推：1.5 ~ 2.8
     · 中游正常角色：0.8 ~ 1.3
     · 冷门角色：0.3 ~ 0.7
     · 大冷 / 纯捆物：0.15 ~ 0.3
3. 忽略背景水印、标题文字与重复的示意图，不要漏掉排列整齐的每个单品。

返回 JSON 格式：
{
  "ip_name": "作品中文名",
  "series_hint": "原画展系列",
  "item_type": "吧唧",
  "items": [
    {
      "label": "孤爪研磨",
      "series_hint": "原画展吧唧",
      "item_type": "吧唧",
      "jp_keywords": "ハイキュー 孤爪研磨 缶バッジ",
      "box": [120, 80, 410, 320],
      "weight": 2.4
    }
  ]
}`;
}

export interface AutoPriceInputItem {
  id: string;
  label: string;
  locked: boolean;
  price: number;
  quantity: number;
  weight: number;
  tag: string;
}

export interface ParsedAutoPriceItem {
  id: string;
  label: string;
  weight: number;
  tag: '' | '捆1' | '捆2' | '捆物' | '自留' | '热烫';
  reason: string;
}

export interface ParsedAutoPriceResponse {
  ip_name: string;
  summary: string;
  items: ParsedAutoPriceItem[];
}

const VALID_TAGS = new Set(['', '捆1', '捆2', '捆物', '自留', '热烫']);

export function buildAutoPricePrompt(params: {
  ipName: string;
  category: string;
  targetTotal: number;
  items: AutoPriceInputItem[];
}): string {
  const listText = params.items
    .map(
      (it, idx) =>
        `${idx + 1}. id="${it.id}", 名称="${it.label}", 数量=${it.quantity}, 当前单价=${it.price}, 锁定=${it.locked ? '是' : '否'}`
    )
    .join('\n');

  return `你是一位精通二次元谷子（徽章/吧唧、立牌、色纸、拍立得、挂件、盲抽周边）拼团市场行情的资深团长。
请根据作品 IP、谷子品类以及以下单品列表，结合当前二级市场谷圈热度，为每个单品评估合理的热度调价权重（weight）与拼团标记（tag），输出严格的 JSON 对象，不要包含任何多余解释或 Markdown 标记。

当前拼团信息：
- 作品 IP：${params.ipName || '未指定（请根据角色名推断）'}
- 谷子品类：${params.category || '通用'}
- 预期总价：¥${params.targetTotal}

单品列表：
${listText}

要求：
1. weight 采用真实谷圈宽幅冷烫体系（支持 5x~10x 价差，范围 0.1~10.0）：
   - 现象级顶流/隐藏款：3.0 ~ 6.0
   - 热门主推：1.5 ~ 2.8
   - 中游正常角色：0.8 ~ 1.3
   - 冷门角色：0.3 ~ 0.7
   - 大冷/纯捆物：0.15 ~ 0.3
2. tag 只能从以下 6 个值中选其一：""、"热烫"、"捆1"、"捆2"、"捆物"、"自留"。
3. 必须完整保留每个输入项的 id，不要遗漏或新增 id。
4. summary 用一句话（25字以内）概括本次调价梯度策略。

返回 JSON 格式：
{
  "ip_name": "作品中文名",
  "summary": "顶流烫门显著上浮，冷门下调促成团",
  "items": [
    {
      "id": "原样返回的id",
      "label": "角色名",
      "weight": 2.4,
      "tag": "热烫",
      "reason": "高人气核心角色"
    }
  ]
}`;
}

export function parseAutoPriceResponseText(
  rawText: string,
  inputItems: AutoPriceInputItem[],
  fallbackIpName = ''
): ParsedAutoPriceResponse {
  const cleaned = cleanDirtyJson(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`模型返回的调价结果无法解析为合法 JSON: ${(err as Error).message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('模型返回的调价结果格式异常（非 JSON 对象）');
  }

  const record = parsed as Record<string, unknown>;
  const ipName =
    typeof record.ip_name === 'string' && record.ip_name.trim()
      ? record.ip_name.trim().slice(0, 60)
      : fallbackIpName.trim().slice(0, 60) || '';
  const summary =
    typeof record.summary === 'string' && record.summary.trim()
      ? record.summary.trim().slice(0, 80)
      : '已按角色市场热度完成宽幅自动调价梯度分配';

  const rawItems = Array.isArray(record.items) ? record.items : [];
  const byId = new Map<string, Record<string, unknown>>();
  const byLabel = new Map<string, Record<string, unknown>>();

  for (const entry of rawItems) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    if (typeof obj.id === 'string' && obj.id.trim()) {
      byId.set(obj.id.trim(), obj);
    }
    if (typeof obj.label === 'string' && obj.label.trim()) {
      byLabel.set(obj.label.trim(), obj);
    }
  }

  const normalizedItems: ParsedAutoPriceItem[] = inputItems.map((orig) => {
    const matched = byId.get(orig.id) ?? byLabel.get(orig.label);
    const rawWeight = matched ? Number(matched.weight) : orig.weight;
    const weight = Number.isFinite(rawWeight)
      ? clamp(Math.round(rawWeight * 100) / 100, VLM_WEIGHT_MIN, VLM_WEIGHT_MAX)
      : orig.weight;

    const rawTag = matched && typeof matched.tag === 'string' ? matched.tag.trim() : '';
    const tag = (VALID_TAGS.has(rawTag) ? rawTag : '') as ParsedAutoPriceItem['tag'];
    const reason =
      matched && typeof matched.reason === 'string' ? matched.reason.trim().slice(0, 40) : '';

    return {
      id: orig.id,
      label: orig.label,
      weight,
      tag,
      reason,
    };
  });

  return {
    ip_name: ipName,
    summary,
    items: normalizedItems,
  };
}
