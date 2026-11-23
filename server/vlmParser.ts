import type { NormalizedVlmItem, ParsedVlmResponse, RawVlmItem } from './types';

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

  // Strip ```json ... ``` fences if present
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    text = fenceMatch[1].trim();
  }

  // Extract outermost { ... }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }

  // Remove trailing commas before } or ]
  text = text.replace(/,\s*([}\]])/g, '$1');

  return text;
}

/**
 * 将检测框归一化到 [0, 1] 坐标系，并计算防挡脸默认锚点：
 * - 值在 (1, 1000] 按 0~1000 归一化
 * - 值 > 1000 按图片像素宽高归一化
 * - 过滤面积 < 0.001 的噪点框
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

  // Enforce ymin < ymax and xmin < xmax
  if (ymin > ymax) [ymin, ymax] = [ymax, ymin];
  if (xmin > xmax) [xmin, xmax] = [xmax, xmin];

  ymin = clamp(ymin, 0, 1);
  xmin = clamp(xmin, 0, 1);
  ymax = clamp(ymax, 0, 1);
  xmax = clamp(xmax, 0, 1);

  const area = (ymax - ymin) * (xmax - xmin);
  if (area < 0.001) return null;

  // 防挡脸默认锚点：水平居中，垂直落在中下部 85% 边缘
  const x = round4(clamp((xmin + xmax) / 2, 0.03, 0.97));
  const y = round4(clamp(ymin + (ymax - ymin) * 0.85, 0.05, 0.96));

  return {
    box: [round4(ymin), round4(xmin), round4(ymax), round4(xmax)],
    x,
    y,
  };
}

/**
 * 解析并规范化 VLM 响应 JSON
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

  const rawItems = Array.isArray(record.items) ? (record.items as RawVlmItem[]) : [];
  const items: NormalizedVlmItem[] = [];

  for (let i = 0; i < rawItems.length; i++) {
    const raw = rawItems[i];
    if (!raw || typeof raw !== 'object') continue;
    const normalizedGeo = normalizeVlmBox(raw.box, imgWidth, imgHeight);
    if (!normalizedGeo) continue;

    const rawLabel = typeof raw.label === 'string' ? raw.label.trim() : '';
    const label = rawLabel ? rawLabel.slice(0, 24) : `谷子${items.length + 1}`;

    const rawWeight = Number(raw.weight);
    const weight = Number.isFinite(rawWeight) ? clamp(Math.round(rawWeight * 100) / 100, 0.3, 2.5) : 1.0;

    items.push({
      label,
      box: normalizedGeo.box,
      x: normalizedGeo.x,
      y: normalizedGeo.y,
      weight,
    });
  }

  return { ip_name: ipName, items };
}

/**
 * SPEC 4.2 标准 VLM Prompt 模板
 */
export function buildVlmDetectPrompt(ipHint?: string): string {
  const hintText = ipHint?.trim() || '无';
  return `你是一位精通二次元谷子（徽章/吧唧、立牌、色纸、盲抽周边）拼团的资深团长。
请识别图中每一个独立的周边商品单品，输出严格的 JSON 对象，不要包含任何多余解释或 Markdown 标记。

要求：
1. 识别作品 IP 的中文常用名（如用户提供了提示“${hintText}”请优先参考）。
2. 为每个独立谷子给出角色中文俗称（或款式简称，2~8字）、检测框 box、以及预估的谷圈拼团热度权重 weight（基准均价为 1.0，热门角色 1.15~1.8，冷门/捆物 0.5~0.85）。
3. box 坐标格式严格为 [ymin, xmin, ymax, xmax]，采用 0~1000 整数坐标系（左上角为 [0, 0]，右下角为 [1000, 1000]）。
4. 忽略背景水印、标题文字与重复的示意图，不要漏掉排列整齐的每个单品。

返回 JSON 格式：
{
  "ip_name": "作品中文名",
  "items": [
    {
      "label": "角色名",
      "box": [120, 80, 410, 320],
      "weight": 1.35
    }
  ]
}`;
}
