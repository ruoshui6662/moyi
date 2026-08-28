import { buildBatchMessages, buildMessages } from './templates';
import { logger } from '../utils/logger';
import type { TranslationPromptStyle } from '../utils/prompts';

export interface PromptOptions {
  promptStyle?: TranslationPromptStyle;
  useCustomPrompt?: boolean;
  customPrompt?: string;
}

export interface TranslationRequest extends PromptOptions {
  text: string;
  targetLanguage: string;
  endpoint: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  disableReasoning?: boolean;
}

export interface BatchTranslationRequest extends Omit<TranslationRequest, 'text'> {
  paragraphs: string[];
  maxBatchSize?: number;
  pageContext?: string;
}

export class TranslationServiceError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'TranslationServiceError';
  }
}

/**
 * 是否为本机/内网可信任地址：http 明文传输仅在这些目标上放行。
 * 第一性原理：风险来自 Key 跨越用户不控制的网络（公网/WAN）；
 * 用户自管的本机环回与内网私有网段（NAS/路由器上的自建 API 服务常见 http 部署）
 * 属于用户信任边界，由用户自行承担。
 */
/**
 * 是否为本机/内网可信任地址：http 明文传输仅在这些目标上放行。
 * 第一性原理：风险来自 Key 跨越用户不控制的网络（公网/WAN）；
 * 用户自管的本机环回与内网私有网段（NAS/路由器上的自建 API 服务常见 http 部署）
 * 属于用户信任边界，由用户自行承担。
 */
const isTrustedPlaintextHost = (hostname: string): boolean => {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host === '::1') return true;
  // mDNS 链路本地名称（.local 永不跨越路由器，不会被公网路由）
  if (host.endsWith('.local')) return true;

  // IPv4 直写，或 ::ffff: 内嵌 IPv4（WHATWG URL 会把点分形式归一化为十六进制，两者都认）
  let ipv4: string | null = null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    ipv4 = host;
  } else if (host.startsWith('::ffff:')) {
    const tail = host.slice('::ffff:'.length);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) {
      ipv4 = tail;
    } else {
      const hex32 = /^([0-9a-f]{1,4})(?::([0-9a-f]{1,4}))?$/i.exec(tail);
      if (hex32) {
        const hi = Number.parseInt(hex32[1], 16);
        const lo = Number.parseInt(hex32[2] ?? '0', 16);
        ipv4 = `${(hi >>> 8) & 255}.${hi & 255}.${(lo >>> 8) & 255}.${lo & 255}`;
      }
    }
  }
  if (ipv4) {
    const parts = ipv4.split('.').map(Number);
    if (parts[0] === 127) return true; // 回环 127.0.0.0/8
    if (parts[0] === 10) return true; // RFC1918：10.0.0.0/8
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true; // 192.168.0.0/16
    return false;
  }
  // IPv6：链路本地 fe80::/10 与唯一本地地址 fc00::/7
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
  return false;
};

/**
 * 校验用户配置的接口地址：仅接受 http(s) 绝对 URL；https 放行，
 * http 仅允许本机环回与内网私有地址（公网地址强制 https，以免 API Key 明文外传）；
 * 拒绝 URL 内嵌 userinfo 凭证。非法返回明确错误文案。
 */
export const validateEndpointUrl = (endpoint: string): string => {
  const trimmed = endpoint.trim();
  if (!trimmed) throw new TranslationServiceError('请先填写接口地址（Base URL）。');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new TranslationServiceError('接口地址不是有效的 URL，应以 https:// 开头。');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TranslationServiceError('接口地址协议不受支持，仅允许 https://（内网服务可用 http://内网地址）。');
  }
  if (url.username || url.password) {
    throw new TranslationServiceError('接口地址不应包含用户名或密码。');
  }
  if (url.protocol === 'http:' && !isTrustedPlaintextHost(url.hostname)) {
    throw new TranslationServiceError('http:// 仅允许本机与内网地址（localhost / 127.0.0.1 / 10.x / 172.16~31.x / 192.168.x / *.local），公网地址必须使用 https:// 以免 API Key 明文传输。');
  }
  return trimmed;
};

/**
 * 归一化 Base URL：去尾斜杠、剥掉误填的 /chat/completions 后缀，并校验协议安全。
 * 翻译与模型列表等所有派生路径必须共用，避免"翻译可用但 /models 404"的不一致。
 */
export const normalizeBaseUrl = (endpoint: string): string => {
  validateEndpointUrl(endpoint);
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/chat/completions')
    ? trimmed.slice(0, -'/chat/completions'.length)
    : trimmed;
};

const normalizeEndpoint = (endpoint: string): string => `${normalizeBaseUrl(endpoint)}/chat/completions`;

/** 提取 SSE 帧中的增量文本：仅 delta.content 属于流式增量，message/text 视为完整内容。 */
const extractStreamDeltaContent = (json: Record<string, unknown>): string | undefined => {
  const choices = Array.isArray(json.choices) ? json.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  if (!first || typeof first !== 'object') return undefined;
  const delta = first.delta as Record<string, unknown> | undefined;
  if (delta && typeof delta === 'object' && typeof delta.content === 'string' && delta.content) {
    return delta.content;
  }
  return undefined;
};

/** 逐行解析响应帧：兼容 `data: {...}` SSE 行与无前缀的裸 JSON 行（NDJSON）。 */
const collectFrames = (lines: string[]): unknown[] => {
  const frames: unknown[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let jsonText = trimmed;
    if (jsonText.startsWith('data:')) jsonText = jsonText.slice(5).trim();
    if (!jsonText || jsonText === '[DONE]') continue;
    try {
      frames.push(JSON.parse(jsonText) as unknown);
    } catch {
      // 跳过无法解析的行
    }
  }
  return frames;
};

const reduceFrames = (frames: unknown[]): { payload: unknown; mode: 'json' | 'sse' } => {
  const deltas = frames
    .filter((frame): frame is Record<string, unknown> => Boolean(frame && typeof frame === 'object'))
    .map(extractStreamDeltaContent)
    .filter((part): part is string => Boolean(part));
  if (deltas.length > 0) return { payload: { content: deltas.join('') }, mode: 'sse' };
  return { payload: frames[frames.length - 1], mode: 'sse' };
};

/**
 * 从响应文本提取 JSON 载荷。
 * 部分 OpenAI 兼容中转（如 New API / 9router）即使请求未带 stream:true，
 * 也可能返回流式文本。整块 JSON 解析失败后按行兜底，兼容：
 *   - SSE 帧：`data: {...}` 行；
 *   - 无前缀的裸 JSON 行（NDJSON 等实现）。
 * delta 帧按序合并增量文本；非 delta 帧（完整 message/choices）取最后一帧。
 */
export const parseResponseBody = (text: string): { payload: unknown; mode: 'json' | 'sse' | 'none' } => {
  const trimmed = text.trim();
  if (!trimmed) return { payload: undefined, mode: 'none' };
  try {
    return { payload: JSON.parse(trimmed) as unknown, mode: 'json' };
  } catch {
    const frames = collectFrames(trimmed.split(/\r?\n/));
    if (frames.length === 0) return { payload: undefined, mode: 'none' };
    return reduceFrames(frames);
  }
};

/** 构造非 2xx 的服务错误；对 429 限流给出可操作的提示并保留原始 detail 供排查。 */
export const throwHttpError = (status: number, detail: string): never => {
  if (status === 429) {
    const resetHint = /reset after (\d+)s/i.exec(detail);
    throw new TranslationServiceError(
      resetHint
        ? `请求过于频繁（429），请约 ${resetHint[1]} 秒后重试，或检查中转渠道的速率限制。原始错误：${detail}`
        : `请求过于频繁（429），请稍后重试，或检查中转渠道的速率限制、API Key 额度与并发配置。原始错误：${detail}`,
      status,
    );
  }
  throw new TranslationServiceError(`翻译服务请求失败 (${status})${detail ? `：${detail}` : ''}`, status);
};

const contentToText = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!Array.isArray(value)) return undefined;

  const parts = value
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      const item = part as { text?: unknown; content?: unknown; value?: unknown };
      return [item.text, item.content, item.value]
        .find((candidate) => typeof candidate === 'string' && candidate.trim()) as string | undefined ?? '';
    })
    .filter(Boolean);
  return parts.length ? parts.join('').trim() : undefined;
};

export const extractTranslationContent = (payload: unknown): { content: string; source: 'content' | 'reasoning' | 'refusal' | 'text' } | undefined => {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = payload as Record<string, unknown>;

  const direct = [value.output_text, value.text, value.content, value.result]
    .map(contentToText)
    .find(Boolean);
  if (direct) return { content: direct, source: 'text' };

  const choices = Array.isArray(value.choices) ? value.choices : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue;
    const item = choice as Record<string, unknown>;
    const message = item.message;
    if (message && typeof message === 'object') {
      const msg = message as Record<string, unknown>;
      const content = contentToText(msg.content);
      if (content) return { content, source: 'content' };
      const refusal = contentToText(msg.refusal);
      if (refusal) return { content: refusal, source: 'refusal' };
      const reasoning = contentToText(msg.reasoning);
      if (reasoning) return { content: reasoning, source: 'reasoning' };
    }
    const choiceText = contentToText(item.text) ?? contentToText(item.content) ?? contentToText(item.reasoning);
    if (choiceText) {
      const source: 'content' | 'reasoning' | 'refusal' | 'text' = item.reasoning ? 'reasoning' : 'text';
      return { content: choiceText, source };
    }
  }

  const output = Array.isArray(value.output) ? value.output : [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = (item as Record<string, unknown>).content;
    const result = contentToText(content) ?? contentToText((item as Record<string, unknown>).text);
    if (result) return { content: result, source: 'content' };
  }

  return undefined;
};

const describeChoicesDetail = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') return '无响应体';
  const value = payload as Record<string, unknown>;
  const choices = Array.isArray(value.choices) ? value.choices : [];
  if (choices.length === 0) return 'choices 为空数组';

  const first = choices[0] as Record<string, unknown>;
  const finishReason = first.finish_reason ?? first.finish_reason ?? 'undefined';
  const message = first.message as Record<string, unknown> | undefined;
  if (message && typeof message === 'object') {
    const msgKeys = Object.keys(message);
    const contentVal = typeof message.content === 'string' ? `"${message.content.slice(0, 80)}"` : typeof message.content === 'undefined' ? 'undefined' : String(message.content);
    const refusalVal = typeof message.refusal === 'string' ? `"${message.refusal.slice(0, 80)}"` : typeof message.refusal === 'undefined' ? 'undefined' : String(message.refusal);
    return `finish_reason=${finishReason}; message keys=[${msgKeys.join(',')}] content=${contentVal} refusal=${refusalVal}`;
  }

  const keys = Object.keys(first);
  const firstText = contentToText(first.text) ?? contentToText(first.content);
  return `finish_reason=${finishReason}; choice keys=[${keys.join(',')}] text=${firstText ?? 'none'}`;
};

/**
 * 诊断「正文缺失」的具体原因，给用户可操作的提示而不是泛泛的“内容拒绝”。
 * 典型场景（网关模型聚合轮换到推理模型）：finish_reason=length 且 content 为空、
 * 但 message.reasoning_content 非空——模型的输出配额被思维链耗尽；
 * 或 finish_reason=stop 且正文为空（真实拒绝/空回复）。
 */
const describeUnrecognizedHint = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') return null;
  const rawChoices = (payload as Record<string, unknown>).choices;
  const choices = Array.isArray(rawChoices) ? rawChoices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  if (!first || typeof first !== 'object') return null;
  const message = first.message as Record<string, unknown> | undefined;
  const finish = first.finish_reason;
  const content = message ? contentToText(message.content) : undefined;
  const reasoningContent = message ? message.reasoning_content : undefined;

  if (finish === 'length' && !content && typeof reasoningContent === 'string' && reasoningContent.trim()) {
    return '看起来模型把输出配额用在了思维链上（正文为空且 finish_reason=length）：请求可能轮换到了推理模型，或网关未透传「关闭推理」设置。请改选普通模型，确认已开启「关闭推理模式」，或在网关/服务商侧关闭该模型的思维链后重试。';
  }
  if (finish === 'stop' && !content && !contentToText(message?.refusal)) {
    return '模型返回了空正文（finish_reason=stop）：可能是内容被策略拒绝或空回复，请检查原文后重试；若使用模型聚合轮换，建议确认未选中推理模型。';
  }
  return null;
};

/** 统一「无法识别」错误文案：能定位原因时给出可操作提示，否则保留通用猜测。 */
const buildUnrecognizedMessage = (payload: unknown, detail: string): string => {
  const base = `翻译服务返回了无法识别的结果，顶层字段：${describeResponseShape(payload)}，选择详情：${detail}。`;
  const hint = describeUnrecognizedHint(payload);
  if (hint) return `${base}${hint}`;
  return `${base}如该字段显示 content=null 或 finish_reason=stop，说明模型触发了内容拒绝策略，请检查原文或联系模型提供商。`;
};

const describeResponseShape = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') return typeof payload;
  return Object.keys(payload as Record<string, unknown>).slice(0, 12).join(', ') || '空对象';
};

export const testOpenAICompatibleConnection = async (
  request: Omit<TranslationRequest, 'text'>,
  signal?: AbortSignal,
): Promise<string> => {
  return translateWithOpenAICompatible({
    ...request,
    text: 'hi',
    maxTokens: 16,
  }, signal);
};

export const translateWithOpenAICompatible = async (
  request: TranslationRequest,
  signal?: AbortSignal,
): Promise<string> => {
  if (!request.apiKey.trim()) throw new TranslationServiceError('请先在插件设置中填写 API Key。');
  if (!request.endpoint.trim()) throw new TranslationServiceError('请先填写 API Endpoint。');
  if (!request.model.trim()) throw new TranslationServiceError('请先填写模型名称。');
  if (!request.text.trim()) return '';

  const controller = new AbortController();
  const startedAt = Date.now();
  const url = normalizeEndpoint(request.endpoint);
  const maxTokens = request.maxTokens ?? 8192;
  const disableReasoning = request.disableReasoning ?? false;
  const requestOverrides = disableReasoning ? { enable_thinking: false as const, thinking: { type: 'disabled' as const } } : {};
  logger.info('provider.request.start', {
    url,
    model: request.model,
    targetLanguage: request.targetLanguage,
    inputCharacters: request.text.length,
    maxTokens,
    disableReasoning,
  });
  const timeout = globalThis.setTimeout(() => controller.abort(), 30_000);
  const abortFromCaller = (): void => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${request.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        temperature: 0,
        max_tokens: maxTokens,
        ...requestOverrides,
        messages: buildMessages(request.text, request.targetLanguage, {
          promptStyle: request.promptStyle,
          useCustomPrompt: request.useCustomPrompt,
          customPrompt: request.customPrompt,
        }),
      }),
    });

    logger.info('provider.response.received', {
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - startedAt,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      logger.error('provider.response.http_error', { status: response.status, detail });
      throwHttpError(response.status, detail);
    }

    const bodyText = await response.text();
    const parsed = parseResponseBody(bodyText);
    logger.debug('provider.response.parsed', { mode: parsed.mode, bytes: bodyText.length });
    if (parsed.mode === 'none') {
      throw new TranslationServiceError(
        `翻译服务返回了无法解析的内容（前 120 字符：${bodyText.slice(0, 120)}）。若服务商以 SSE 流式返回，请检查中转是否强制开启流式输出。`,
      );
    }
    const payload = parsed.payload;
    logger.debug('provider.response.shape', { keys: payload && typeof payload === 'object' ? Object.keys(payload) : typeof payload });
    const extraction = extractTranslationContent(payload);
    if (!extraction) {
      const detail = describeChoicesDetail(payload);
      logger.error('provider.response.unrecognized', { shape: describeResponseShape(payload), choices: detail });
      throw new TranslationServiceError(buildUnrecognizedMessage(payload, detail));
    }
    if (extraction.source === 'reasoning') {
      logger.info('provider.response.reasoning_extracted', { durationMs: Date.now() - startedAt, outputCharacters: extraction.content.length, model: request.model });
    }
    logger.info('provider.request.success', { durationMs: Date.now() - startedAt, outputCharacters: extraction.content.length });
    return extraction.content;
  } catch (error) {
    logger.error('provider.request.failure', { durationMs: Date.now() - startedAt, error });
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new TranslationServiceError('模型请求超过 30 秒仍未响应，请检查 Endpoint、网络或模型服务。');
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromCaller);
  }
};

export const extractTaggedTranslations = (raw: string, count: number): string[] => {
  const results: string[] = new Array(count).fill('');

  for (let i = 1; i <= count; i++) {
    const regex = new RegExp(`<paragraph_${i}>([\\s\\S]*?)</paragraph_${i}>`);
    const match = raw.match(regex);
    if (match) {
      results[i - 1] = match[1].trim();
    } else {
      logger.error('provider.batch_tag.missing', { paragraphIndex: i, total: count, rawPreview: raw.slice(0, 300) });
    }
  }

  const filled = results.filter((t) => t.length > 0).length;
  if (filled < count) {
    logger.warn('provider.batch_split.partial', { expected: count, got: filled });
  }
  return results;
};

export interface PlainCompletionRequest {
  endpoint: string;
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * 与翻译无关的通用补全：自定义 system/user 消息，复用同一套
 * 端点规范化 / 响应解析（含 SSE 兼容）/ reasoning 提取容错。
 * 当前用于字幕 AI 断句（输出简化 VTT）。
 */
export const completeWithOpenAICompatible = async (
  request: PlainCompletionRequest,
  signal?: AbortSignal,
): Promise<string> => {
  if (!request.apiKey.trim()) throw new TranslationServiceError('请先在插件设置中填写 API Key。');
  if (!request.endpoint.trim()) throw new TranslationServiceError('请先填写 API Endpoint。');
  if (!request.model.trim()) throw new TranslationServiceError('请先填写模型名称。');

  const controller = new AbortController();
  const startedAt = Date.now();
  const url = normalizeEndpoint(request.endpoint);
  const timeoutMs = request.timeoutMs ?? 45_000;
  logger.info('provider.completion.start', { url, model: request.model, inputCharacters: request.user.length });
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  const abortFromCaller = (): void => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${request.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        temperature: 0,
        max_tokens: request.maxTokens ?? 8192,
        enable_thinking: false,
        thinking: { type: 'disabled' },
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
      }),
    });
    logger.info('provider.completion.received', { status: response.status, ok: response.ok, durationMs: Date.now() - startedAt });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throwHttpError(response.status, detail);
    }
    const bodyText = await response.text();
    const parsed = parseResponseBody(bodyText);
    if (parsed.mode === 'none') {
      throw new TranslationServiceError(`服务返回了无法解析的内容（前 120 字符：${bodyText.slice(0, 120)}）。`);
    }
    const extraction = extractTranslationContent(parsed.payload);
    if (!extraction) {
      const detail = describeChoicesDetail(parsed.payload);
      logger.error('provider.completion.unrecognized', { shape: describeResponseShape(parsed.payload), choices: detail });
      throw new TranslationServiceError(buildUnrecognizedMessage(parsed.payload, detail));
    }
    logger.info('provider.completion.success', { durationMs: Date.now() - startedAt, outputCharacters: extraction.content.length });
    return extraction.content;
  } catch (error) {
    logger.error('provider.completion.failure', { durationMs: Date.now() - startedAt, error });
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new TranslationServiceError(`模型请求超过 ${Math.round(timeoutMs / 1000)} 秒仍未响应，请检查 Endpoint、网络或模型服务。`);
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromCaller);
  }
};

export interface BatchTranslateConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  targetLanguage: string;
  maxTokens?: number;
  disableReasoning?: boolean;
  pageContext?: string;
}

export const translateBatchWithOpenAICompatible = async (
  request: BatchTranslationRequest,
  signal?: AbortSignal,
): Promise<string[]> => {
  const maxBatchSize = Math.min(request.maxBatchSize ?? 10, 20);
  const results: string[] = new Array(request.paragraphs.length).fill('');
  const allParagraphs = request.paragraphs;
  let batchIndex = 0;

  for (let i = 0; i < allParagraphs.length; i += maxBatchSize) {
    if (signal?.aborted) {
      throw new TranslationServiceError('批量翻译已取消。');
    }
    const batchStart = i;
    const batchEnd = Math.min(i + maxBatchSize, allParagraphs.length);
    const batch = allParagraphs.slice(batchStart, batchEnd);
    const startedAt = Date.now();
    logger.info('provider.batch.start', {
      batchIndex: batchIndex++,
      batchSize: batch.length,
      totalBatches: Math.ceil(allParagraphs.length / maxBatchSize),
    });

    try {
      const rawResponse = await requestBatch(batch, { ...request, pageContext: request.pageContext }, signal);
      const translations = extractTaggedTranslations(rawResponse, batch.length);
      for (let j = 0; j < batch.length; j++) {
        results[batchStart + j] = translations[j];
      }
      logger.info('provider.batch.success', {
        batchIndex: batchIndex - 1,
        durationMs: Date.now() - startedAt,
        outputCharacters: rawResponse.length,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : '批量翻译失败';
      for (let j = 0; j < batch.length; j++) {
        results[batchStart + j] = `翻译失败：${msg}`;
      }
    }
  }

  return results;
};

const requestBatch = async (
  paragraphs: string[],
  request: Omit<BatchTranslationRequest, 'paragraphs' | 'maxBatchSize'> & { pageContext?: string },
  signal?: AbortSignal,
): Promise<string> => {
  if (!request.apiKey.trim()) throw new TranslationServiceError('请先在插件设置中填写 API Key。');
  if (!request.endpoint.trim()) throw new TranslationServiceError('请先填写 API Endpoint。');
  if (!request.model.trim()) throw new TranslationServiceError('请先填写模型名称。');

  const controller = new AbortController();
  const startedAt = Date.now();
  const url = normalizeEndpoint(request.endpoint);
  const maxTokens = request.maxTokens ?? 8192;
  const disableReasoning = request.disableReasoning ?? false;
  const requestOverrides = disableReasoning ? { enable_thinking: false as const, thinking: { type: 'disabled' as const } } : {};
  const context = (request.pageContext ?? '').trim();
  const contextSuffix = context ? `Context for translation: ${context}` : '';

  logger.info('provider.request.start', {
    url,
    model: request.model,
    targetLanguage: request.targetLanguage,
    inputCharacters: paragraphs.join(' ').length,
    maxTokens,
    disableReasoning,
    isBatch: true,
    batchSize: paragraphs.length,
    hasContext: Boolean(context),
  });
  const timeout = globalThis.setTimeout(() => controller.abort(), 30_000);
  const abortFromCaller = (): void => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${request.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        temperature: 0,
        max_tokens: maxTokens,
        ...requestOverrides,
        messages: buildBatchMessages(paragraphs, request.targetLanguage, contextSuffix, { promptStyle: request.promptStyle, useCustomPrompt: request.useCustomPrompt, customPrompt: request.customPrompt }),
      }),
    });

    logger.info('provider.response.received', {
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - startedAt,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      logger.error('provider.response.http_error', { status: response.status, detail });
      throwHttpError(response.status, detail);
    }

    const bodyText = await response.text();
    const parsed = parseResponseBody(bodyText);
    logger.debug('provider.response.parsed', { mode: parsed.mode, bytes: bodyText.length });
    if (parsed.mode === 'none') {
      throw new TranslationServiceError(
        `翻译服务返回了无法解析的内容（前 120 字符：${bodyText.slice(0, 120)}）。若服务商以 SSE 流式返回，请检查中转是否强制开启流式输出。`,
      );
    }
    const payload = parsed.payload;
    const extraction = extractTranslationContent(payload);
    if (!extraction) {
      const detail = describeChoicesDetail(payload);
      logger.error('provider.response.unrecognized', { shape: describeResponseShape(payload), choices: detail });
      throw new TranslationServiceError(buildUnrecognizedMessage(payload, detail));
    }
    logger.info('provider.request.success', { durationMs: Date.now() - startedAt, outputCharacters: extraction.content.length, isBatch: true });
    return extraction.content;
  } catch (error) {
    logger.error('provider.request.failure', { durationMs: Date.now() - startedAt, error });
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new TranslationServiceError('模型请求超过 30 秒仍未响应，请检查 Endpoint、网络或模型服务。');
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromCaller);
  }
};

export interface TagStreamEvent {
  partial?: { index: number; text: string };
  completed?: { index: number; text: string };
}

export interface TagStreamParser {
  push: (chunk: string) => TagStreamEvent[];
  getCompletedCount: () => number;
}

export const createTagStreamParser = (count: number): TagStreamParser => {
  let buffer = '';
  const completed = new Set<number>();

  const firstIncomplete = (): number => {
    for (let i = 1; i <= count; i += 1) {
      if (!completed.has(i)) return i;
    }
    return count + 1;
  };

  const push = (chunk: string): TagStreamEvent[] => {
    buffer += chunk;
    const events: TagStreamEvent[] = [];

    for (let i = 1; i <= count; i += 1) {
      if (completed.has(i)) continue;
      const openTag = `<paragraph_${i}>`;
      const closeTag = `</paragraph_${i}>`;
      const openIndex = buffer.indexOf(openTag);
      if (openIndex === -1) continue;
      const closeIndex = buffer.indexOf(closeTag, openIndex);
      if (closeIndex === -1) continue;
      completed.add(i);
      const text = buffer.slice(openIndex + openTag.length, closeIndex).trim();
      events.push({ completed: { index: i - 1, text } });
    }

    const current = firstIncomplete();
    if (current <= count) {
      const openTag = `<paragraph_${current}>`;
      const closeTag = `</paragraph_${current}>`;
      const openIndex = buffer.indexOf(openTag);
      if (openIndex !== -1 && buffer.indexOf(closeTag, openIndex) === -1) {
        const text = buffer
          .slice(openIndex + openTag.length)
          .replace(/<[^>]*$/, '')
          .trim();
        if (text) events.push({ partial: { index: current - 1, text } });
      }
    }

    if (current > 1) {
      const closeTag = `</paragraph_${current - 1}>`;
      const closeIndex = buffer.indexOf(closeTag);
      if (closeIndex !== -1) buffer = buffer.slice(closeIndex + closeTag.length);
    }

    return events;
  };

  return { push, getCompletedCount: () => completed.size };
};

export const extractStreamDelta = (json: Record<string, unknown>): string | undefined => {
  const choices = Array.isArray(json.choices) ? json.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  if (!first || typeof first !== 'object') return undefined;
  const delta = first.delta as Record<string, unknown> | undefined;
  if (delta && typeof delta === 'object' && typeof delta.content === 'string' && delta.content) {
    return delta.content;
  }
  if (typeof first.text === 'string' && first.text) return first.text;
  const message = first.message as Record<string, unknown> | undefined;
  if (message && typeof message === 'object') {
    return contentToText(message.content);
  }
  return undefined;
};

export interface StreamBatchHandlers {
  onPartial: (index: number, text: string) => void;
  onParagraph: (index: number, text: string) => void;
}

export const streamTranslateBatch = async (
  request: BatchTranslationRequest,
  handlers: StreamBatchHandlers,
  signal?: AbortSignal,
): Promise<{ completedCount: number }> => {
  if (!request.apiKey.trim()) throw new TranslationServiceError('请先在插件设置中填写 API Key。');
  if (!request.endpoint.trim()) throw new TranslationServiceError('请先填写 API Endpoint。');
  if (!request.model.trim()) throw new TranslationServiceError('请先填写模型名称。');
  const paragraphs = request.paragraphs;
  if (paragraphs.length === 0) return { completedCount: 0 };

  const controller = new AbortController();
  const startedAt = Date.now();
  const url = normalizeEndpoint(request.endpoint);
  const maxTokens = request.maxTokens ?? 8192;
  const disableReasoning = request.disableReasoning ?? false;
  const requestOverrides = disableReasoning ? { enable_thinking: false as const, thinking: { type: 'disabled' as const } } : {};
  const context = (request.pageContext ?? '').trim();
  const contextSuffix = context ? `Context for translation: ${context}` : '';
  const parser = createTagStreamParser(paragraphs.length);
  logger.info('provider.stream.start', {
    url,
    model: request.model,
    targetLanguage: request.targetLanguage,
    inputCharacters: paragraphs.join(' ').length,
    maxTokens,
    disableReasoning,
    batchSize: paragraphs.length,
    hasContext: Boolean(context),
  });
  const timeout = globalThis.setTimeout(() => controller.abort(), 30_000);
  const abortFromCaller = (): void => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });

  const dispatchEvents = (delta: string): void => {
    for (const event of parser.push(delta)) {
      if (event.completed) handlers.onParagraph(event.completed.index, event.completed.text);
      else if (event.partial) handlers.onPartial(event.partial.index, event.partial.text);
    }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${request.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        temperature: 0,
        max_tokens: maxTokens,
        stream: true,
        ...requestOverrides,
        messages: buildBatchMessages(paragraphs, request.targetLanguage, contextSuffix, { promptStyle: request.promptStyle, useCustomPrompt: request.useCustomPrompt, customPrompt: request.customPrompt }),
      }),
    });

    logger.info('provider.stream.response.received', {
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get('content-type') ?? '',
      durationMs: Date.now() - startedAt,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      logger.error('provider.stream.http_error', { status: response.status, detail });
      throwHttpError(response.status, detail);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!response.body || contentType.includes('application/json')) {
      logger.warn('provider.stream.fallback_json', { contentType, hasBody: Boolean(response.body) });
      const bodyText = await response.text();
      const parsed = parseResponseBody(bodyText);
      if (parsed.mode === 'none') {
        throw new TranslationServiceError(
          `翻译服务返回了无法解析的内容（前 120 字符：${bodyText.slice(0, 120)}）。若服务商以 SSE 流式返回，请检查中转是否强制开启流式输出。`,
        );
      }
      const payload = parsed.payload;
      const extraction = extractTranslationContent(payload);
      if (!extraction) {
        const detail = describeChoicesDetail(payload);
        throw new TranslationServiceError(buildUnrecognizedMessage(payload, detail));
      }
      const translations = extractTaggedTranslations(extraction.content, paragraphs.length);
      for (let i = 0; i < translations.length; i += 1) {
        if (translations[i]) handlers.onParagraph(i, translations[i]);
      }
      return { completedCount: translations.filter(Boolean).length };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    const handleSseLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') return;
      try {
        const json = JSON.parse(data) as Record<string, unknown>;
        const delta = extractStreamDelta(json);
        if (delta) dispatchEvents(delta);
      } catch {
        // 跳过无法解析的 SSE 帧（部分服务商会夹杂心跳/注释行）
      }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() ?? '';
        for (const line of lines) handleSseLine(line);
      }
      sseBuffer += decoder.decode();
      if (sseBuffer) handleSseLine(sseBuffer);
    } finally {
      void reader.cancel().catch(() => undefined);
    }

    const completedCount = parser.getCompletedCount();
    logger.info('provider.stream.success', {
      durationMs: Date.now() - startedAt,
      completedCount,
      expected: paragraphs.length,
    });
    return { completedCount };
  } catch (error) {
    logger.error('provider.stream.failure', { durationMs: Date.now() - startedAt, error });
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new TranslationServiceError('模型请求超过 30 秒仍未响应，请检查 Endpoint、网络或模型服务。');
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromCaller);
  }
};
