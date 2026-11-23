import { GoogleGenAI } from '@google/genai';
import { buildVlmDetectPrompt } from './vlmParser';

export interface VlmProvider {
  readonly providerName: string;
  readonly modelName: string;
  isConfigured(): boolean;
  detectGoods(params: {
    imageBuffer: Buffer;
    mimeType: string;
    ipHint?: string;
  }): Promise<string>;
}

/**
 * 魔数校验：确保上传文件确实是 PNG / JPEG / WEBP 图片
 */
export function detectImageMimeType(buffer: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (!buffer || buffer.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
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

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // WEBP: RIFF....WEBP
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

export class GeminiVlmProvider implements VlmProvider {
  public readonly providerName = 'gemini';
  public readonly modelName: string;

  constructor(modelName = 'gemini-4-hydrogen') {
    this.modelName = modelName;
  }

  public isConfigured(): boolean {
    const key = process.env.GEMINI_API_KEY?.trim();
    return Boolean(key && key !== 'MY_GEMINI_API_KEY');
  }

  public async detectGoods(params: {
    imageBuffer: Buffer;
    mimeType: string;
    ipHint?: string;
  }): Promise<string> {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
      throw new Error('后端尚未配置有效的 GEMINI_API_KEY，请在 AI Studio Settings > Secrets 中配置后重试。');
    }

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const promptText = buildVlmDetectPrompt(params.ipHint);
    const base64Data = params.imageBuffer.toString('base64');

    const response = await ai.models.generateContent({
      model: this.modelName,
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: params.mimeType,
              data: base64Data,
            },
          },
          {
            text: promptText,
          },
        ],
      },
      config: {
        responseMimeType: 'application/json',
      },
    });

    const text = response.text;
    if (!text || !text.trim()) {
      throw new Error('视觉模型返回为空，请换一张更清晰的谷子平铺图重试。');
    }
    return text;
  }
}
