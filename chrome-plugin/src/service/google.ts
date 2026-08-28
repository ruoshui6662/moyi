import { TranslationServiceError, validateEndpointUrl } from './common';
import type { MtAdapter, MtTranslationRequest } from './mt';
import { rejoinChunkTranslations, splitOverlongParagraphs } from './mt';

/**
 * 谷歌翻译（Workspace Translator 内部端点，方案 C）：
 *   https://translate-pa.googleapis.com/v1/translateHtml
 * - 免用户密钥：复用 Google 自家产品的公共 API Key（X-Goog-API-Key）与 client=wt_lib；
 *   用户视角与微软翻译一致——选中即用，无凭据填写。
 * - 方法来源：开源项目 read-frog 的 google 适配器（GPLv3，思路层面的学习与独立重写）。
 * - 端点把请求文本当 HTML 解析：发送前 HTML 转义（& < > " '），响应 HTML 编码、解码一次还原。
 * - 响应结构：result[0][0] 为译文 HTML 字符串。
 * - v1 单文本/请求（与 read-frog 一致，最稳）；多文本批量化为后续优化。
 * - 风险：端点未公开、无 SLA、ToS 灰色；公共 key 可能被 Google 吊销；Google 服务在国内通常无法直连。
 */

export const GOOGLE_TRANSLATE_ENDPOINT = 'https://translate-pa.googleapis.com/v1/translateHtml';
/** Google 自家 Workspace Translator 产品的公共 key（read-frog 同款，非用户密钥）。 */
export const GOOGLE_TRANSLATE_API_KEY = 'AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520';
export const GOOGLE_TRANSLATE_CLIENT = 'wt_lib';
export const GOOGLE_MAX_ITEM_BYTES = 5000;

const REQUEST_TIMEOUT_MS = 30_000;

/** 目标语言 → Google 翻译语言码。 */
export const googleTargetLang = (targetLanguage: string): string => {
  switch (targetLanguage) {
    case '简体中文':
      return 'zh-CN';
    case '繁體中文':
      return 'zh-TW';
    case 'English':
      return 'en';
    case '日本語':
      return 'ja';
    case '한국어':
      return 'ko';
    default:
      return 'zh-CN';
  }
};

/** 发送前 HTML 转义：端点会把请求文本当 HTML 解析，裸 < 会被当标签融合。 */
const escapeForHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** 接收后 HTML 解码一次：与转义精确互逆（&amp; 最后还原，避免误还原）。 */
const unescapeHtml = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

const normalizeEndpoint = (endpoint: string): string => endpoint.trim().replace(/\/+$/, '');

const guardGoogleRequest = (request: MtTranslationRequest): string => {
  if (!request.endpoint.trim()) throw new TranslationServiceError('请先填写接口地址。');
  validateEndpointUrl(request.endpoint);
  return normalizeEndpoint(request.endpoint);
};

/** 单条翻译：构造 translateHtml 请求并解析 result[0][0]。 */
const translateOne = async (
  endpoint: string,
  fromLang: string,
  toLang: string,
  text: string,
  signal?: AbortSignal,
): Promise<string> => {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abortFromCaller = (): void => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    const body = JSON.stringify([[[escapeForHtml(text)], fromLang, toLang], GOOGLE_TRANSLATE_CLIENT]);
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json+protobuf',
        'X-Goog-API-Key': GOOGLE_TRANSLATE_API_KEY,
      },
      body,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new TranslationServiceError(`谷歌翻译服务请求失败 (${response.status})${detail ? `：${detail}` : ''}`, response.status);
    }
    const result: unknown = await response.json();
    if (!Array.isArray(result) || !Array.isArray(result[0]) || typeof result[0][0] !== 'string') {
      throw new TranslationServiceError('谷歌翻译返回了无法识别的响应。');
    }
    return unescapeHtml((result[0] as unknown[])[0] as string);
  } catch (error) {
    if (error instanceof TranslationServiceError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new TranslationServiceError('谷歌翻译请求超过 30 秒仍未响应，请检查网络（Google 服务在国内通常无法直连）。');
    }
    throw new TranslationServiceError(`谷歌翻译网络请求失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromCaller);
  }
};

/**
 * 批量翻译：输入 N 条，按序返回 N 条。
 * v1 单文本/请求串行（与 read-frog 一致）；超长段落切块后逐块翻译、按原文重组；
 * 空文本不进请求，保持 1:1 契约。
 */
export const translateWithGoogle = async (
  texts: string[],
  request: MtTranslationRequest,
  signal?: AbortSignal,
): Promise<string[]> => {
  if (texts.length === 0) return [];
  const endpoint = guardGoogleRequest(request);
  const fromLang = 'auto';
  const toLang = googleTargetLang(request.targetLanguage);
  const { chunks, itemOfChunk } = splitOverlongParagraphs(texts, GOOGLE_MAX_ITEM_BYTES);
  const chunkResults: string[] = [];
  for (const chunk of chunks) {
    chunkResults.push(await translateOne(endpoint, fromLang, toLang, chunk, signal));
  }
  return rejoinChunkTranslations(chunkResults, itemOfChunk, texts.length);
};

/** 最小连通性测试：翻译 "hi"→zh-CN，返回可见译文（兼作可达性探测）。 */
export const testGoogleConnection = async (
  request: MtTranslationRequest,
  signal?: AbortSignal,
): Promise<string> => {
  const results = await translateWithGoogle(['hi'], { ...request, targetLanguage: '简体中文' }, signal);
  return results[0] ?? '';
};

export const googleAdapter: MtAdapter = {
  id: 'google',
  maxBatchSize: 100,
  maxItemBytes: GOOGLE_MAX_ITEM_BYTES,
  translateBatch: translateWithGoogle,
  testConnection: testGoogleConnection,
};