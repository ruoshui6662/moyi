/**
 * 传统 MT 后端家族抽象（第一性原理）：
 * DeepL 与腾讯翻译是同一个「角色」——无模型、无提示词、无流式、按字符计费。
 * 统一接口收敛各家差异：批量入口保证「输入 N 条 → 输出 N 条」的 1:1 契约，
 * 超长条目由适配器自行切分并重组，内容侧渲染层的段落索引不受影响。
 */

import { deeplAdapter } from './deepl';
import { tencentAdapter } from './tencent';
import { microsoftAdapter } from './microsoft';
import { googleAdapter } from './google';

export interface MtTranslationRequest {
  /** DeepL API Key / 腾讯 SecretId。 */
  apiKey: string;
  /** 腾讯 SecretKey（TC3 签名材料）；DeepL 不使用。 */
  apiSecret?: string;
  endpoint: string;
  /** 腾讯 Region；DeepL 不使用。 */
  region?: string;
  /** 插件的展示语言（如「简体中文」），由适配器映射为自己语言的码。 */
  targetLanguage: string;
}

export interface MtAdapter {
  id: 'deepl' | 'tencent' | 'microsoft' | 'google';
  /** 文档声明的单次请求携带条数上限（适配器内部自行再分片）。 */
  maxBatchSize: number;
  /** 单条文本长度上限（字节）；超长由适配器切块再重组。 */
  maxItemBytes: number;
  /** 批量翻译：输入 N 条，按序返回 N 条；失败条目以空串/错误占位标记。 */
  translateBatch(texts: string[], request: MtTranslationRequest, signal?: AbortSignal): Promise<string[]>;
  /** 最小连通性测试：返回一段可见的译文文本。 */
  testConnection(request: MtTranslationRequest, signal?: AbortSignal): Promise<string>;
}

/** 按 UTF-8 字节切分单条文本：绝不切断多字节字符（码点边界切）。 */
export const splitByUtf8Bytes = (text: string, maxBytes: number): string[] => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return [text];
  const chunks: string[] = [];
  let start = 0;
  let end = 0;
  while (end < bytes.length) {
    // 向前找不超过 maxBytes 的码点边界：UTF-8 连续字节首字节不以 10 开头
    end = Math.min(start + maxBytes, bytes.length);
    if (end < bytes.length) {
      while (end > start && (bytes[end] & 0xc0) === 0x80) end -= 1;
    }
    chunks.push(decoder.decode(bytes.subarray(start, end)));
    start = end;
  }
  return chunks;
};

/**
 * 把一批段落按字节上限切块，并记录「每块属于哪个原段落」。
 * 空文本不产生块（1:1 契约由 rejoin 的缺省空串保证）；
 * 返回 itemOfChunk[k] = 第 k 块所属的原段落下标；chunks 与原段落顺序一致。
 */
export const splitOverlongParagraphs = (
  texts: string[],
  maxBytes: number,
): { chunks: string[]; itemOfChunk: number[] } => {
  const chunks: string[] = [];
  const itemOfChunk: number[] = [];
  texts.forEach((text, itemIndex) => {
    if (text.trim().length === 0) return;
    const parts = splitByUtf8Bytes(text, maxBytes);
    for (const part of parts) {
      chunks.push(part);
      itemOfChunk.push(itemIndex);
    }
  });
  return { chunks, itemOfChunk };
};

/** 把块级译文按 itemOfChunk 重组回段落级，保持长度 == count。 */
export const rejoinChunkTranslations = (
  chunkTranslations: string[],
  itemOfChunk: number[],
  count: number,
): string[] => {
  const out = new Array<string>(count).fill('');
  const parts: string[][] = Array.from({ length: count }, () => []);
  for (let k = 0; k < chunkTranslations.length; k += 1) {
    const itemIndex = itemOfChunk[k];
    if (itemIndex >= 0 && itemIndex < count && chunkTranslations[k]) {
      parts[itemIndex].push(chunkTranslations[k]);
    }
  }
  for (let i = 0; i < count; i += 1) {
    if (parts[i].length > 0) out[i] = parts[i].join('\n');
  }
  return out;
};

const MT_ADAPTERS: Record<string, MtAdapter> = {
  deepl: deeplAdapter,
  tencent: tencentAdapter,
  microsoft: microsoftAdapter,
  google: googleAdapter,
};

/** 按 providerId 取传统 MT 适配器；未知 id 抛错（由上层转成用户可读文案）。 */
export const getMtAdapter = (id: string): MtAdapter => {
  const adapter = MT_ADAPTERS[id];
  if (!adapter) throw new Error(`未知的翻译服务：${id}`);
  return adapter;
};