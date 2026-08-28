import { TranslationServiceError, validateEndpointUrl } from './common';
import type { MtAdapter, MtTranslationRequest } from './mt';
import { rejoinChunkTranslations, splitOverlongParagraphs } from './mt';

/**
 * 微软翻译（Edge 网页翻译同款端点）：
 *   https://edge.microsoft.com/translate/translatetext
 * - 无鉴权（免密钥）、POST 裸 JSON 字符串数组，按序返回 [{ translations: [{ text }] }]；
 *   `from` 传空串 = 自动检测源语言，`to` 为目标语言码。
 * - 方法来源：开源项目 read-frog 的 microsoft 适配器（GPLv3，思路层面的学习与独立重写）。
 *   该端点是一个未公开、无 SLA 的在线服务，协议变更可能随时发生（2026-07 刚经历一次迁移）。
 * - Edge 端点在每个请求上都会运行 HTML 标签对齐器：裸 `<` 会被融合成伪标签，
 *   因此发送前转义 `&`/`<`，收到后再解码一次，保证原文往返一致。
 * - 超长段落复用家族切块/重组（splitOverlongParagraphs），保持「输入 N 条 → 输出 N 条」。
 */

export const MICROSOFT_TRANSLATE_ENDPOINT = 'https://edge.microsoft.com/translate/translatetext';
export const MICROSOFT_MAX_ITEM_BYTES = 5000;

const REQUEST_TIMEOUT_MS = 30_000;

/** 目标语言 → Edge translatetext 语言码（简体沿用 read-frog 验证过的 zh；繁中需真机实测）。 */
export const microsoftTargetLang = (targetLanguage: string): string => {
  switch (targetLanguage) {
    case '简体中文':
      return 'zh';
    case '繁體中文':
      return 'zh-TW';
    case 'English':
      return 'en';
    case '日本語':
      return 'ja';
    case '한국어':
      return 'ko';
    default:
      return 'zh';
  }
};

/** 发送前转义：先 & 后 <，避免被 HTML 标签对齐器当作伪标签。 */
const escapeForAligner = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** 接收后解码一次：先 &lt; 后 &amp;，与转义精确互逆。 */
const unescapeFromAligner = (text: string): string => text.replace(/&lt;/g, '<').replace(/&amp;/g, '&');

const normalizeEndpoint = (endpoint: string): string => endpoint.trim().replace(/\/+$/, '');

const guardMicrosoftRequest = (request: MtTranslationRequest): string => {
  if (!request.endpoint.trim()) throw new TranslationServiceError('请先填写接口地址。');
  validateEndpointUrl(request.endpoint);
  return normalizeEndpoint(request.endpoint);
};

const requestMicrosoftOnce = async (
  endpoint: string,
  toLang: string,
  texts: string[],
  signal?: AbortSignal,
): Promise<string[]> => {
  const url = `${endpoint}?from=&to=${encodeURIComponent(toLang)}&isEnterpriseClient=false`;
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abortFromCaller = (): void => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(texts),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new TranslationServiceError(`微软翻译服务请求失败 (${response.status})${detail ? `：${detail}` : ''}`, response.status);
    }
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) {
      throw new TranslationServiceError('微软翻译返回了无法识别的响应（应为数组）。');
    }
    const result = new Array<string>(texts.length).fill('');
    for (let i = 0; i < texts.length; i += 1) {
      const item = payload[i] as { translations?: { text?: unknown }[] } | undefined;
      const raw = item?.translations?.[0]?.text;
      if (typeof raw === 'string') result[i] = unescapeFromAligner(raw);
    }
    return result;
  } catch (error) {
    if (error instanceof TranslationServiceError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new TranslationServiceError('微软翻译请求超过 30 秒仍未响应，请检查网络。');
    }
    throw new TranslationServiceError(`微软翻译网络请求失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromCaller);
  }
};

/**
 * 批量翻译：输入 N 条，按序返回 N 条。
 * 空文本条目不跳过（Edge 端点按数组索引一一对应，跳过会错位），
 * 超长段落切块后一次性发送，按原文分块归属重组。
 */
export const translateWithMicrosoft = async (
  texts: string[],
  request: MtTranslationRequest,
  signal?: AbortSignal,
): Promise<string[]> => {
  if (texts.length === 0) return [];
  const endpoint = guardMicrosoftRequest(request);
  const toLang = microsoftTargetLang(request.targetLanguage);
  const { chunks, itemOfChunk } = splitOverlongParagraphs(texts, MICROSOFT_MAX_ITEM_BYTES);
  const chunkResults = await requestMicrosoftOnce(
    endpoint,
    toLang,
    chunks.map((chunk) => escapeForAligner(chunk)),
    signal,
  );
  return rejoinChunkTranslations(chunkResults, itemOfChunk, texts.length);
};

/** 最小连通性测试：翻译 "hi"→zh，返回可见译文。 */
export const testMicrosoftConnection = async (
  request: MtTranslationRequest,
  signal?: AbortSignal,
): Promise<string> => {
  const results = await translateWithMicrosoft(['hi'], { ...request, targetLanguage: '简体中文' }, signal);
  return results[0] ?? '';
};

export const microsoftAdapter: MtAdapter = {
  id: 'microsoft',
  maxBatchSize: 100,
  maxItemBytes: MICROSOFT_MAX_ITEM_BYTES,
  translateBatch: translateWithMicrosoft,
  testConnection: testMicrosoftConnection,
};