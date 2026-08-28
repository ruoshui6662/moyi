import { TranslationServiceError, validateEndpointUrl } from './common';
import { logger } from '../utils/logger';
import type { MtAdapter, MtTranslationRequest } from './mt';

/**
 * DeepL 官方翻译 API 后端：无需提示词，批量逐段直译。
 * - 网络调用始终发生在 background（content 的 fetch 受页面 CORS 限制）。
 * - Free / Pro 由 endpoint 区分（api-free.deepl.com / api.deepl.com，均含 /v2）。
 * - 认证：Header `Authorization: DeepL-Auth-Key <key>`。
 */

export interface DeeplRequest {
  texts: string[];
  apiKey: string;
  endpoint: string;
  targetLanguage: string;
}

const REQUEST_TIMEOUT_MS = 30_000;

/** 目标语言 → DeepL 语言码；不支持的回落 ZH。 */
export const deeplTargetLang = (targetLanguage: string): string => {
  switch (targetLanguage) {
    case '简体中文':
      return 'ZH';
    case '繁體中文':
      return 'ZH-HANT';
    case 'English':
      return 'EN';
    case '日本語':
      return 'JA';
    case '한국어':
      return 'KO';
    default:
      return 'ZH';
  }
};

const normalizeDeeplEndpoint = (endpoint: string): string => endpoint.trim().replace(/\/+$/, '');

const buildRequest = (request: DeeplRequest): { url: string; body: string } => {
  const url = `${normalizeDeeplEndpoint(request.endpoint)}/translate`;
  const body = JSON.stringify({
    text: request.texts,
    target_lang: deeplTargetLang(request.targetLanguage),
  });
  return { url, body };
};

/** 非 2xx / 429 规范化为 TranslationServiceError，保留原始 detail 供排查。 */
const throwDeeplHttpError = (status: number, detail: string): never => {
  if (status === 429) {
    throw new TranslationServiceError(`DeepL 请求过于频繁（429）：${detail || '请稍后重试，或检查套餐额度。'}`, status);
  }
  throw new TranslationServiceError(`翻译服务请求失败 (${status})${detail ? `：${detail}` : ''}`, status);
};

/**
 * 批量翻译：一次请求多段文本，按序返回译文数组。
 * DeepL 对空文本抛 400，因此空文本直接返回空数组。
 */
export const translateWithDeepl = async (
  request: DeeplRequest,
  signal?: AbortSignal,
): Promise<string[]> => {
  if (!request.apiKey.trim()) throw new TranslationServiceError('请先填写 API Key。');
  if (!request.endpoint.trim()) throw new TranslationServiceError('请先填写接口地址。');
  validateEndpointUrl(request.endpoint);

  const texts = request.texts.filter((text) => text.trim().length > 0);
  if (texts.length === 0) return [];

  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abortFromCaller = (): void => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });

  const { url, body } = buildRequest({ ...request, texts });
  logger.info('provider.deepl.request.start', {
    url,
    inputCharacters: texts.join(' ').length,
    targetLang: deeplTargetLang(request.targetLanguage),
  });

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `DeepL-Auth-Key ${request.apiKey}`,
      },
      body,
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      logger.error('provider.deepl.http_error', { status: response.status, detail });
      throwDeeplHttpError(response.status, detail);
    }

    const payload = (await response.json()) as { translations?: { text?: string }[] };
    const translations = Array.isArray(payload.translations)
      ? payload.translations.map((item) => (typeof item?.text === 'string' ? item.text : ''))
      : [];
    logger.info('provider.deepl.request.success', { outputCharacters: translations.join('').length });
    return translations;
  } catch (error) {
    logger.error('provider.deepl.request.failure', { error });
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new TranslationServiceError('DeepL 请求超过 30 秒仍未响应，请检查网络或接口地址。');
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromCaller);
  }
};

/** 最小文本连通性测试。 */
export const testDeeplConnection = async (
  request: Pick<DeeplRequest, 'apiKey' | 'endpoint' | 'targetLanguage'>,
  signal?: AbortSignal,
): Promise<string> => {
  const texts = await translateWithDeepl({ ...request, texts: ['hi'] }, signal);
  logger.info('provider.deepl.connection_test.success', { returnedCharacters: texts[0]?.length ?? 0 });
  return texts[0] ?? '';
};

/**
 * MtAdapter 实现：DeepL 无单条切分需求（内容侧段落在其接受范围内），
 * 但必须保持「输入 N 条 → 输出 N 条」的 1:1 契约——空文本直接占位空串，
 * 不复用 translateWithDeepl 的「过滤后返回」语义（那会错位下游索引）。
 */
export const deeplAdapter: MtAdapter = {
  id: 'deepl',
  maxBatchSize: 20,
  maxItemBytes: 5000,
  async translateBatch(texts, request, signal) {
    const indices: number[] = [];
    const nonEmpty: string[] = [];
    texts.forEach((text, index) => {
      if (text.trim().length > 0) {
        indices.push(index);
        nonEmpty.push(text);
      }
    });
    if (nonEmpty.length === 0) return texts.map(() => '');
    const result = await translateWithDeepl(
      {
        apiKey: request.apiKey,
        endpoint: request.endpoint,
        targetLanguage: request.targetLanguage,
        texts: nonEmpty,
      },
      signal,
    );
    const out = new Array<string>(texts.length).fill('');
    indices.forEach((index, k) => {
      out[index] = result[k] ?? '';
    });
    return out;
  },
  async testConnection(request, signal) {
    return testDeeplConnection(request, signal);
  },
};