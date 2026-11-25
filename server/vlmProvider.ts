import net from 'node:net';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import {
  buildAutoPricePrompt,
  buildVlmDetectPrompt,
  type AutoPriceInputItem,
} from './vlmParser';

export type ServerAiProtocol = 'server_default' | 'openai_compatible' | 'gemini' | 'anthropic';

export interface CustomAiConfig {
  protocol: ServerAiProtocol;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface VlmProvider {
  readonly providerName: string;
  readonly modelName: string;
  isConfigured(): boolean;
  detectGoods(params: {
    imageBuffer: Buffer;
    mimeType: string;
    ipHint?: string;
    customConfig?: CustomAiConfig;
  }): Promise<{ rawText: string; providerUsed: string }>;
  autoPriceGoods(params: {
    ipName: string;
    category: string;
    targetTotal: number;
    items: AutoPriceInputItem[];
    imageBuffer?: Buffer;
    mimeType?: string;
    customConfig?: CustomAiConfig;
  }): Promise<{ rawText: string; providerUsed: string }>;
  testConnection(params: {
    customConfig?: CustomAiConfig;
  }): Promise<{ providerUsed: string; replyPreview: string; latencyMs: number }>;
}

const DEFAULT_BASE_URLS: Record<Exclude<ServerAiProtocol, 'server_default'>, string> = {
  openai_compatible: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com',
  anthropic: 'https://api.anthropic.com',
};

const DEFAULT_MODELS: Record<Exclude<ServerAiProtocol, 'server_default'>, string> = {
  openai_compatible: 'gpt-4o-mini',
  gemini: 'gemini-2.5-flash',
  anthropic: 'claude-sonnet-4-20250514',
};

/**
 * 魔数校验：确保上传文件确实是 PNG / JPEG / WEBP 图片
 */
export function detectImageMimeType(buffer: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (!buffer || buffer.length < 12) return null;

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

function isPrivateOrBlockedIp(ip: string): boolean {
  const clean = ip.replace(/^\[|\]$/g, '').toLowerCase();
  if (clean === '::1' || clean === '::' || clean.startsWith('fe80:') || clean.startsWith('fc') || clean.startsWith('fd')) {
    return true;
  }
  const v4Mapped = clean.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const ipv4 = v4Mapped ? v4Mapped[1] : clean;

  if (net.isIPv4(ipv4)) {
    const parts = ipv4.split('.').map(Number);
    const [a, b] = parts;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  }

  return false;
}

/**
 * 严格校验自定义 API Base URL，防止 SSRF（仅允许公网 HTTPS 地址）
 */
export function validateSafeExternalBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new Error('自定义接口地址不能为空。');
  }
  if (trimmed.length > 300) {
    throw new Error('接口地址过长。');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('接口地址格式无效，请输入完整的 https:// 地址。');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('出于安全限制，自定义 AI 接口地址仅支持 https:// 协议。');
  }

  if (parsed.username || parsed.password) {
    throw new Error('接口地址中不可包含内嵌账号密码。');
  }

  const host = parsed.hostname.toLowerCase();
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal' ||
    isPrivateOrBlockedIp(host)
  ) {
    throw new Error('禁止访问内网、本地回环或元数据地址，请填写公网 AI 接口域名。');
  }

  return parsed.toString().replace(/\/+$/, '');
}

/**
 * 规范化 OpenAI 兼容协议的 chat/completions 完整 URL
 */
export function resolveOpenAiChatEndpoint(baseUrl: string): string {
  const safeBase = validateSafeExternalBaseUrl(baseUrl);
  if (/\/chat\/completions$/i.test(safeBase)) {
    return safeBase;
  }
  return `${safeBase}/chat/completions`;
}

/**
 * 规范化 Gemini 原生协议的 generateContent 完整 URL
 */
export function resolveGeminiEndpoint(baseUrl: string, model: string): string {
  const safeBase = validateSafeExternalBaseUrl(baseUrl);
  const safeModel = encodeURIComponent(model.replace(/^models\//, '').trim());
  if (!safeModel) throw new Error('请填写有效的 Gemini 模型名称。');
  if (/\/v1(?:beta)?$/i.test(safeBase)) {
    return `${safeBase}/models/${safeModel}:generateContent`;
  }
  return `${safeBase}/v1beta/models/${safeModel}:generateContent`;
}

/**
 * 规范化 Anthropic Claude 原生协议的 messages 完整 URL
 */
export function resolveAnthropicEndpoint(baseUrl: string): string {
  const safeBase = validateSafeExternalBaseUrl(baseUrl);
  if (/\/v1\/messages$/i.test(safeBase)) {
    return safeBase;
  }
  if (/\/v1$/i.test(safeBase)) {
    return `${safeBase}/messages`;
  }
  return `${safeBase}/v1/messages`;
}

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 55000
): Promise<{ status: number; data: Record<string, unknown>; rawText: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    const rawText = await res.text();
    let data: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(rawText);
      if (parsed && typeof parsed === 'object') {
        data = parsed as Record<string, unknown>;
      }
    } catch {
      // non-json error response
    }
    return { status: res.status, data, rawText };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('上游 AI 接口请求超时，请检查接口地址连通性或稍后重试。');
    }
    throw new Error(`无法连接到目标 AI 接口：${err instanceof Error ? err.message : '网络异常'}`);
  } finally {
    clearTimeout(timer);
  }
}

function extractUpstreamErrorMessage(data: Record<string, unknown>, status: number, rawText: string): string {
  const errObj = data.error as Record<string, unknown> | string | undefined;
  if (typeof errObj === 'string' && errObj.trim()) return errObj.trim();
  if (errObj && typeof errObj === 'object' && typeof errObj.message === 'string' && errObj.message.trim()) {
    return errObj.message.trim();
  }
  if (typeof data.message === 'string' && data.message.trim()) {
    return data.message.trim();
  }
  if (status === 401 || status === 403) {
    return 'API Key 无效、已过期或无权访问所选模型。';
  }
  if (status === 404) {
    return '接口路径或模型名称不存在，请核对 Base URL 与模型名。';
  }
  if (status === 429) {
    return 'API Key 触发频率限制或余额不足。';
  }
  const snippet = rawText.trim().slice(0, 140);
  return snippet ? `HTTP ${status}: ${snippet}` : `上游接口返回 HTTP ${status}`;
}

export class MultiProtocolVlmProvider implements VlmProvider {
  public readonly providerName = 'gemini';
  public readonly modelName: string;
  private readonly fetchImpl: typeof fetch;

  constructor(modelName = 'gemini-4-hydrogen', fetchImpl?: typeof fetch) {
    this.modelName = modelName;
    this.fetchImpl = fetchImpl ?? fetch;
  }

  public isConfigured(): boolean {
    const key = process.env.GEMINI_API_KEY?.trim();
    return Boolean(key && key !== 'MY_GEMINI_API_KEY');
  }

  private async runPrompt(params: {
    promptText: string;
    imageBuffer?: Buffer;
    mimeType?: string;
    jsonMode?: boolean;
    customConfig?: CustomAiConfig;
  }): Promise<{ rawText: string; providerUsed: string }> {
    const cfg = params.customConfig;
    const protocol: ServerAiProtocol = cfg?.protocol ?? 'server_default';

    // 1. Built-in server-side Gemini via @google/genai
    if (protocol === 'server_default') {
      const apiKey = process.env.GEMINI_API_KEY?.trim();
      if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
        throw new Error(
          '服务端默认 GEMINI_API_KEY 尚未配置。您可以在 AI Studio Settings > Secrets 中配置，或在「设置 → AI 模型与密钥」中填写您自己的 API Key（兼容 OpenAI / Gemini / Claude 协议）。'
        );
      }

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
      if (params.imageBuffer && params.mimeType) {
        parts.push({
          inlineData: {
            mimeType: params.mimeType,
            data: params.imageBuffer.toString('base64'),
          },
        });
      }
      parts.push({ text: params.promptText });

      const fallbackModel = 'gemini-3.1-flash-lite';
      const candidateModels =
        this.modelName === fallbackModel ? [this.modelName] : [this.modelName, fallbackModel];

      const isTransientUnavailable = (msg: string): boolean =>
        /503|UNAVAILABLE|high demand|overloaded|temporarily unavailable|ECONNRESET|ETIMEDOUT/i.test(msg);

      let lastErr: unknown = null;

      for (const targetModel of candidateModels) {
        const maxAttempts = targetModel === this.modelName ? 2 : 2;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            const response = await ai.models.generateContent({
              model: targetModel,
              contents: { parts },
              config: {
                ...(params.jsonMode ? { responseMimeType: 'application/json' } : {}),
                thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              },
            });

            const text = response.text;
            if (!text || !text.trim()) {
              throw new Error('默认视觉模型返回内容为空，请重试。');
            }
            return { rawText: text, providerUsed: `gemini:${targetModel}` };
          } catch (err) {
            lastErr = err;
            const rawMsg = err instanceof Error ? err.message : String(err);
            if (isTransientUnavailable(rawMsg)) {
              if (attempt < maxAttempts) {
                const delayMs = 600 * attempt + Math.floor(Math.random() * 250);
                await new Promise((resolve) => setTimeout(resolve, delayMs));
                continue;
              }
              // Move on to next fallback Gemini model
              break;
            }
            // Non-transient error (e.g., 400/403/404/429): stop immediately
            break;
          }
        }
        // If the failure was non-transient, don't try fallback model
        const lastMsg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? '');
        if (!isTransientUnavailable(lastMsg)) {
          break;
        }
      }

      const rawMsg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? '未知错误');
      if (/<!doctype|<html|Unexpected token ['"]<['"]/i.test(rawMsg)) {
        throw new Error('上游 Gemini 网关暂时返回了非 JSON 异常页面，请稍后重试。');
      }
      if (/503|UNAVAILABLE|high demand|overloaded/i.test(rawMsg)) {
        throw new Error(
          '内置 Gemini 模型当前处于高并发拥堵状态（503），请稍等几秒后重试，或在「设置 → AI 模型与密钥」中切换自有 API Key。'
        );
      }
      if (/PERMISSION_DENIED|API_KEY_INVALID|403/i.test(rawMsg)) {
        throw new Error('内置 Gemini API Key 无效或无权访问，请在 Settings > Secrets 中检查配置。');
      }
      if (/RESOURCE_EXHAUSTED|429/i.test(rawMsg)) {
        throw new Error('内置 Gemini 服务配额已达上限（429），请稍后重试或在 Settings > Secrets 中切换可用密钥。');
      }
      if (/NOT_FOUND|404/i.test(rawMsg)) {
        throw new Error(`默认视觉模型 ${this.modelName} 不可用（404），请检查模型配置。`);
      }
      throw lastErr instanceof Error ? lastErr : new Error(rawMsg);
    }

    // Custom BYOK protocols require a user API key
    const userApiKey = cfg?.apiKey?.trim();
    if (!userApiKey) {
      throw new Error('请先在「设置 → AI 模型与密钥」中填写有效的 API Key。');
    }

    const baseUrl = cfg?.baseUrl?.trim() || DEFAULT_BASE_URLS[protocol];
    const model = cfg?.model?.trim() || DEFAULT_MODELS[protocol];

    // 2. OpenAI-Compatible Protocol (OpenAI, Qwen-VL/DashScope, GLM-4V, OpenRouter, OneAPI/NewAPI relays)
    if (protocol === 'openai_compatible') {
      const endpoint = resolveOpenAiChatEndpoint(baseUrl);
      const userContent: Array<Record<string, unknown>> = [];
      if (params.imageBuffer && params.mimeType) {
        const dataUri = `data:${params.mimeType};base64,${params.imageBuffer.toString('base64')}`;
        userContent.push({
          type: 'image_url',
          image_url: { url: dataUri },
        });
      }
      userContent.push({
        type: 'text',
        text: params.promptText,
      });

      const payload: Record<string, unknown> = {
        model,
        messages: [
          {
            role: 'user',
            content: params.imageBuffer ? userContent : params.promptText,
          },
        ],
        temperature: 0.2,
      };

      const { status, data, rawText } = await this.doFetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userApiKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (status < 200 || status >= 300) {
        throw new Error(extractUpstreamErrorMessage(data, status, rawText));
      }

      const choices = Array.isArray(data.choices) ? data.choices : [];
      const firstChoice = choices[0] as Record<string, unknown> | undefined;
      const message = firstChoice?.message as Record<string, unknown> | undefined;
      let textOut = '';
      if (typeof message?.content === 'string') {
        textOut = message.content;
      } else if (Array.isArray(message?.content)) {
        textOut = message.content
          .map((part) => {
            if (typeof part === 'string') return part;
            if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') {
              return (part as Record<string, unknown>).text as string;
            }
            return '';
          })
          .join('\n');
      }

      if (!textOut.trim()) {
        throw new Error('OpenAI 兼容接口返回文本为空，请确认所选模型支持多模态视觉或文本输出。');
      }

      return { rawText: textOut, providerUsed: `openai:${model}` };
    }

    // 3. Google Gemini Native REST Protocol (user key + optional custom relay baseUrl)
    if (protocol === 'gemini') {
      const endpoint = resolveGeminiEndpoint(baseUrl, model);
      const parts: Array<Record<string, unknown>> = [];
      if (params.imageBuffer && params.mimeType) {
        parts.push({
          inline_data: {
            mime_type: params.mimeType,
            data: params.imageBuffer.toString('base64'),
          },
        });
      }
      parts.push({ text: params.promptText });

      const payload: Record<string, unknown> = {
        contents: [{ role: 'user', parts }],
      };
      if (params.jsonMode) {
        payload.generationConfig = { responseMimeType: 'application/json' };
      }

      const { status, data, rawText } = await this.doFetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': userApiKey,
        },
        body: JSON.stringify(payload),
      });

      if (status < 200 || status >= 300) {
        throw new Error(extractUpstreamErrorMessage(data, status, rawText));
      }

      const candidates = Array.isArray(data.candidates) ? data.candidates : [];
      const firstCand = candidates[0] as Record<string, unknown> | undefined;
      const content = firstCand?.content as Record<string, unknown> | undefined;
      const respParts = Array.isArray(content?.parts) ? content.parts : [];
      const textOut = respParts
        .map((p) => (p && typeof p === 'object' && typeof (p as Record<string, unknown>).text === 'string' ? ((p as Record<string, unknown>).text as string) : ''))
        .join('\n');

      if (!textOut.trim()) {
        throw new Error('Gemini 接口返回文本为空，请检查模型名或安全拦截策略。');
      }

      return { rawText: textOut, providerUsed: `gemini:${model}` };
    }

    // 4. Anthropic Claude Native Messages Protocol
    if (protocol === 'anthropic') {
      const endpoint = resolveAnthropicEndpoint(baseUrl);
      const contentBlocks: Array<Record<string, unknown>> = [];
      if (params.imageBuffer && params.mimeType) {
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: params.mimeType,
            data: params.imageBuffer.toString('base64'),
          },
        });
      }
      contentBlocks.push({
        type: 'text',
        text: params.promptText,
      });

      const payload = {
        model,
        max_tokens: 2048,
        messages: [
          {
            role: 'user',
            content: contentBlocks,
          },
        ],
      };

      const { status, data, rawText } = await this.doFetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': userApiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(payload),
      });

      if (status < 200 || status >= 300) {
        throw new Error(extractUpstreamErrorMessage(data, status, rawText));
      }

      const contentArr = Array.isArray(data.content) ? data.content : [];
      const textOut = contentArr
        .map((blk) =>
          blk && typeof blk === 'object' && (blk as Record<string, unknown>).type === 'text' && typeof (blk as Record<string, unknown>).text === 'string'
            ? ((blk as Record<string, unknown>).text as string)
            : ''
        )
        .join('\n');

      if (!textOut.trim()) {
        throw new Error('Claude 接口返回文本为空，请确认所选模型名称正确。');
      }

      return { rawText: textOut, providerUsed: `anthropic:${model}` };
    }

    throw new Error(`不支持的 AI 协议类型：${String(protocol)}`);
  }

  private async doFetch(
    url: string,
    init: RequestInit
  ): Promise<{ status: number; data: Record<string, unknown>; rawText: string }> {
    if (this.fetchImpl === fetch) {
      return fetchJsonWithTimeout(url, init);
    }
    const res = await this.fetchImpl(url, init);
    const rawText = await res.text();
    let data: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(rawText);
      if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
    } catch {
      // ignore
    }
    return { status: res.status, data, rawText };
  }

  public async detectGoods(params: {
    imageBuffer: Buffer;
    mimeType: string;
    ipHint?: string;
    customConfig?: CustomAiConfig;
  }): Promise<{ rawText: string; providerUsed: string }> {
    const promptText = buildVlmDetectPrompt(params.ipHint);
    return this.runPrompt({
      promptText,
      imageBuffer: params.imageBuffer,
      mimeType: params.mimeType,
      jsonMode: true,
      customConfig: params.customConfig,
    });
  }

  public async autoPriceGoods(params: {
    ipName: string;
    category: string;
    targetTotal: number;
    items: AutoPriceInputItem[];
    imageBuffer?: Buffer;
    mimeType?: string;
    customConfig?: CustomAiConfig;
  }): Promise<{ rawText: string; providerUsed: string }> {
    const promptText = buildAutoPricePrompt({
      ipName: params.ipName,
      category: params.category,
      targetTotal: params.targetTotal,
      items: params.items,
    });
    return this.runPrompt({
      promptText,
      imageBuffer: params.imageBuffer,
      mimeType: params.mimeType,
      jsonMode: true,
      customConfig: params.customConfig,
    });
  }

  public async testConnection(params: {
    customConfig?: CustomAiConfig;
  }): Promise<{ providerUsed: string; replyPreview: string; latencyMs: number }> {
    const start = Date.now();
    const result = await this.runPrompt({
      promptText: '请仅回复两个字：正常',
      jsonMode: false,
      customConfig: params.customConfig,
    });
    return {
      providerUsed: result.providerUsed,
      replyPreview: result.rawText.trim().slice(0, 60),
      latencyMs: Date.now() - start,
    };
  }
}

// Keep backward-compatible export alias
export { MultiProtocolVlmProvider as GeminiVlmProvider };
