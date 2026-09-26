import { buildBatchMessages, buildMessages, buildPrecedingContextBlock } from './templates';
import { logger } from '../utils/logger';
import { filterGlossaryHits, type GlossaryEntry } from '../utils/glossary';
import type { TranslationPromptStyle } from '../utils/prompts';

export interface PromptOptions {
  promptStyle?: TranslationPromptStyle;
  useCustomPrompt?: boolean;
  customPrompt?: string;
  /** 完整术语表；发送前按本批段落做命中过滤，只注入命中项。 */
  glossary?: readonly GlossaryEntry[];
}

export interface TranslationRequest extends PromptOptions {
  text: string;
  targetLanguage: string;
  endpoint: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  disableReasoning?: boolean;
  /** 跨批上文（同文档已入队的相邻原文段）：仅注入 prompt 保持一致性，
   *  不参与段落缓存 key——缓存命中段落按缓存译文渲染，接受轻微措辞不一致。 */
  precedingParagraphs?: string[];
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

/** 可安全重试的失败：瞬时网关错误（408/502/503/504）与网络层错误。
 * 429 单独处理：服务端给出可执行的 Retry-After（≤30s）时等待一次再试；
 * 超时与主动 abort 不重试——超时重试只会更慢，主动 abort 是用户意图。 */
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 502, 503, 504]);
const RETRY_DELAYS_MS = [1000, 3000] as const;
/** 429 等待上限：超过则放弃重试（把用户挂死在未知时长上不如直接报错）。 */
const MAX_429_WAIT_MS = 30_000;

/** 解析 Retry-After（秒数或 HTTP 日期）为毫秒；缺失/非法返回 null。 */
const parseRetryAfterMs = (response: Response): number | null => {
  const header = response.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
};

const isRetryableRequestError = (error: unknown): boolean => {
  if (error instanceof TranslationServiceError) {
    return error.status !== undefined && RETRYABLE_STATUS.has(error.status);
  }
  // fetch 网络失败（连接重置 / DNS 瞬断）为 TypeError；主动 abort 是 DOMException，不在此列
  return error instanceof TypeError;
};

/** 只包住「发起请求到拿到响应头」这一步：已开始接收正文的流绝不重试，避免重复渲染与重复计费。
 *  网络层错误（TypeError）与瞬时 HTTP 状态（408/502/503/504）共享 2 次重试预算；
 *  429 走单独通道：带可执行 Retry-After（≤30s）时等待一次，否则原样返回给调用方
 *  由 throwHttpError 统一处理（既有 429 文案保持不变）。 */
const fetchWithRetry = async (input: string, init: RequestInit): Promise<Response> => {
  let retriedRateLimit = false;
  for (let attempt = 0; ; attempt += 1) {
    const canRetry = attempt < RETRY_DELAYS_MS.length;
    let response: Response;
    try {
      response = await fetch(input, init);
    } catch (error) {
      if (!canRetry || !isRetryableRequestError(error)) throw error;
      logger.warn('provider.request.retry', { attempt: attempt + 1, delayMs: RETRY_DELAYS_MS[attempt], error });
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, RETRY_DELAYS_MS[attempt]);
      });
      continue;
    }
    if (!response.ok && response.status === 429 && !retriedRateLimit) {
      const waitMs = parseRetryAfterMs(response);
      if (waitMs !== null && waitMs <= MAX_429_WAIT_MS) {
        retriedRateLimit = true;
        void response.body?.cancel().catch(() => undefined);
        logger.warn('provider.request.retry_rate_limit', { waitMs });
        await new Promise<void>((resolve) => {
          globalThis.setTimeout(resolve, Math.max(waitMs, 100));
        });
        continue;
      }
    }
    if (response.ok || !canRetry || !RETRYABLE_STATUS.has(response.status)) return response;
    logger.warn('provider.request.retry', { attempt: attempt + 1, delayMs: RETRY_DELAYS_MS[attempt], status: response.status });
    void response.body?.cancel().catch(() => undefined);
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, RETRY_DELAYS_MS[attempt]);
    });
  }
};

/** 读取标准 OpenAI 兼容响应的 finish_reason（用于识别 length 截断）。 */
const readFinishReason = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') return null;
  const choices = (payload as Record<string, unknown>).choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const reason = first && typeof first === 'object' ? (first as Record<string, unknown>).finish_reason : undefined;
  return typeof reason === 'string' && reason ? reason : null;
};

const TRUNCATED_MESSAGE = '译文被服务商输出上限截断（finish_reason=length），未能完整返回。建议：拆分过长段落，或在服务商处提高输出上限。';

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
 * Ollama 本机默认端口：用户按官方示例填「http://localhost:11434」（漏掉版本根 /v1）时，
 * 自动补上 /v1，避免 OpenAI 兼容路径拼成 /chat/completions 而 404。
 * 仅命中本机回环地址 + 默认端口且无路径的裸 base，不碰任何其他服务商与自定义路径。
 */
const OLLAMA_LOCAL_PORT = '11434';
const OLLAMA_LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

const appendOllamaVersionRoot = (base: string): string => {
  try {
    const url = new URL(base);
    if (url.port !== OLLAMA_LOCAL_PORT) return base;
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!OLLAMA_LOCAL_HOSTNAMES.has(hostname)) return base;
    const path = url.pathname.replace(/\/+$/, '');
    if (path !== '' && path !== '/') return base;
    return `${url.origin}/v1`;
  } catch {
    return base;
  }
};

/**
 * 归一化 Base URL：去尾斜杠、剥掉误填的 /chat/completions 后缀，并校验协议安全；
 * 对本机 Ollama 默认端口自动补 /v1。
 * 翻译与模型列表等所有派生路径必须共用，避免"翻译可用但 /models 404"的不一致。
 */
export const normalizeBaseUrl = (endpoint: string): string => {
  validateEndpointUrl(endpoint);
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  const withoutSuffix = trimmed.endsWith('/chat/completions')
    ? trimmed.slice(0, -'/chat/completions'.length)
    : trimmed;
  return appendOllamaVersionRoot(withoutSuffix);
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
 *   - 无前缀的裸 JSON 行（NDJSON 等实现）；
 *   - 整段 JSON 后跟尾随内容 / 多个 JSON 对象无换行拼接 / BOM 前缀：
 *     提取文本中首个完整 JSON 对象。
 * delta 帧按序合并增量文本；非 delta 帧（完整 message/choices）取最后一帧。
 */
export const parseResponseBody = (text: string): { payload: unknown; mode: 'json' | 'sse' | 'none' } => {
  const withoutBom = text.replace(/^\uFEFF/, '');
  const trimmed = withoutBom.trim();
  if (!trimmed) return { payload: undefined, mode: 'none' };
  try {
    return { payload: JSON.parse(trimmed) as unknown, mode: 'json' };
  } catch {
    // 兼容 CR 行尾（个别网关用 \r 分隔帧）
    const frames = collectFrames(trimmed.split(/\r\n|[\r\n]/));
    if (frames.length > 0) return reduceFrames(frames);
    const embedded = extractFirstJsonObject(withoutBom);
    if (embedded !== null) {
      try {
        return { payload: JSON.parse(embedded) as unknown, mode: 'json' };
      } catch {
        // 提取出的对象本身不完整，落入 none
      }
    }
    return { payload: undefined, mode: 'none' };
  }
};

/**
 * 提取文本中首个「完整且括号平衡」的 JSON 对象（跳过前导噪声）。
 * 用于整段解析失败但正文确实以合法 JSON 开头、后续夹带尾随内容/重复对象的场景；
 * 字符串字面量内的括号与转义会被正确跳过。
 */
export const extractFirstJsonObject = (text: string): string | null => {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // 括号未闭合：正文被截断
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
    response = await fetchWithRetry(url, {
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
          glossary: filterGlossaryHits(request.glossary, [request.text]),
        }, buildPrecedingContextBlock(request.precedingParagraphs ?? [])),
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
        buildUnparseableBodyMessage(bodyText, '翻译服务'),
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
    if (readFinishReason(payload) === 'length') {
      logger.error('provider.response.truncated', { model: request.model, finishReason: 'length', outputCharacters: extraction.content.length });
      throw new TranslationServiceError(TRUNCATED_MESSAGE);
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

/** 构造「响应体无法解析」的提示：附带头尾各 120 字符，便于定位脏数据来源。 */
const buildUnparseableBodyMessage = (bodyText: string, serviceLabel: string): string => {
  const head = bodyText.slice(0, 120);
  const tail = bodyText.slice(-120);
  return `${serviceLabel}返回了无法解析的内容（响应体头：${head}${tail ? `；尾：${tail}` : ''}）。若服务商以 SSE 流式返回，请检查中转是否强制开启流式输出。`;
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
  /** 多轮续写（阅读卡追问）：按序拼在首轮 user 之后，构成完整会话。 */
  history?: readonly { role: 'user' | 'assistant'; content: string }[];
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
    const response = await fetchWithRetry(url, {
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
          ...(request.history ?? []).map((turn) => ({ role: turn.role, content: turn.content })),
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
      throw new TranslationServiceError(buildUnparseableBodyMessage(bodyText, '服务'));
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
  const precedingBlock = buildPrecedingContextBlock(request.precedingParagraphs ?? []);
  const contextSuffix = [context ? `Context for translation: ${context}` : '', precedingBlock].filter(Boolean).join('\n\n');

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
    response = await fetchWithRetry(url, {
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
        messages: buildBatchMessages(paragraphs, request.targetLanguage, contextSuffix, { promptStyle: request.promptStyle, useCustomPrompt: request.useCustomPrompt, customPrompt: request.customPrompt, glossary: filterGlossaryHits(request.glossary, paragraphs) }),
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
        buildUnparseableBodyMessage(bodyText, '翻译服务'),
      );
    }
    const payload = parsed.payload;
    const extraction = extractTranslationContent(payload);
    if (!extraction) {
      const detail = describeChoicesDetail(payload);
      logger.error('provider.response.unrecognized', { shape: describeResponseShape(payload), choices: detail });
      throw new TranslationServiceError(buildUnrecognizedMessage(payload, detail));
    }
    if (readFinishReason(payload) === 'length') {
      logger.error('provider.response.truncated', { finishReason: 'length', batchSize: paragraphs.length });
      throw new TranslationServiceError(TRUNCATED_MESSAGE);
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
): Promise<{ completedCount: number; truncated: boolean }> => {
  if (!request.apiKey.trim()) throw new TranslationServiceError('请先在插件设置中填写 API Key。');
  if (!request.endpoint.trim()) throw new TranslationServiceError('请先填写 API Endpoint。');
  if (!request.model.trim()) throw new TranslationServiceError('请先填写模型名称。');
  const paragraphs = request.paragraphs;
  if (paragraphs.length === 0) return { completedCount: 0, truncated: false };

  const controller = new AbortController();
  const startedAt = Date.now();
  const url = normalizeEndpoint(request.endpoint);
  const maxTokens = request.maxTokens ?? 8192;
  const disableReasoning = request.disableReasoning ?? false;
  const requestOverrides = disableReasoning ? { enable_thinking: false as const, thinking: { type: 'disabled' as const } } : {};
  const context = (request.pageContext ?? '').trim();
  const precedingBlock = buildPrecedingContextBlock(request.precedingParagraphs ?? []);
  const contextSuffix = [context ? `Context for translation: ${context}` : '', precedingBlock].filter(Boolean).join('\n\n');
  const parser = createTagStreamParser(paragraphs.length);
  // 最近一帧的 finish_reason：SSE 流与整段 JSON 回退两条路径共用（识别 length 截断）
  let finishReason: string | null = null;
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
  // 超时语义：等响应头阶段 30s 不变；进入流式读取后改为「空闲超时」——
  // 连续 30s 收不到任何字节才中断，另设 5 分钟绝对上限防止挂死。
  // 原实现是总时长 30s 硬顶，会把正在正常出字的流从中间掐断
  // （已出段落保留、后续段落标失败），慢模型/思考型模型必然"翻一半断掉"。
  const STREAM_IDLE_TIMEOUT_MS = 30_000;
  const STREAM_MAX_DURATION_MS = 300_000;
  let abortCause: 'idle' | 'total' | 'caller' | null = null;
  let streamTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const armStreamTimeout = (ms: number): void => {
    if (streamTimer !== undefined) globalThis.clearTimeout(streamTimer);
    streamTimer = globalThis.setTimeout(() => {
      abortCause = 'idle';
      controller.abort();
    }, ms);
  };
  armStreamTimeout(STREAM_IDLE_TIMEOUT_MS);
  const abortFromCaller = (): void => {
    abortCause = 'caller';
    controller.abort();
  };
  signal?.addEventListener('abort', abortFromCaller, { once: true });

  const dispatchEvents = (delta: string): void => {
    for (const event of parser.push(delta)) {
      if (event.completed) handlers.onParagraph(event.completed.index, event.completed.text);
      else if (event.partial) handlers.onPartial(event.partial.index, event.partial.text);
    }
  };

  try {
    const response = await fetchWithRetry(url, {
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
        messages: buildBatchMessages(paragraphs, request.targetLanguage, contextSuffix, { promptStyle: request.promptStyle, useCustomPrompt: request.useCustomPrompt, customPrompt: request.customPrompt, glossary: filterGlossaryHits(request.glossary, paragraphs) }),
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
      // 整段回退：读取整个响应体期间保持 5 分钟上限内的空闲计时
      armStreamTimeout(STREAM_MAX_DURATION_MS - Math.max(0, Date.now() - startedAt));
      const bodyText = await response.text();
      const parsed = parseResponseBody(bodyText);
      if (parsed.mode === 'none') {
        throw new TranslationServiceError(
          buildUnparseableBodyMessage(bodyText, '翻译服务'),
        );
      }
      const payload = parsed.payload;
      const extraction = extractTranslationContent(payload);
      if (!extraction) {
        const detail = describeChoicesDetail(payload);
        throw new TranslationServiceError(buildUnrecognizedMessage(payload, detail));
      }
      finishReason = finishReason ?? readFinishReason(payload);
      const translations = extractTaggedTranslations(extraction.content, paragraphs.length);
      for (let i = 0; i < translations.length; i += 1) {
        if (translations[i]) handlers.onParagraph(i, translations[i]);
      }
      return { completedCount: translations.filter(Boolean).length, truncated: finishReason === 'length' };
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
        const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
        if (choice && typeof choice === 'object') {
          const reason = (choice as Record<string, unknown>).finish_reason;
          if (typeof reason === 'string' && reason) finishReason = reason;
        }
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
        armStreamTimeout(STREAM_IDLE_TIMEOUT_MS);
        if (Date.now() - startedAt > STREAM_MAX_DURATION_MS) {
          abortCause = 'total';
          controller.abort();
          continue;
        }
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
    const truncated = finishReason === 'length';
    if (truncated) {
      // finish_reason=length 且有未完成段落 = 静默截断的直接指纹
      logger.warn('provider.stream.truncated', { durationMs: Date.now() - startedAt, completedCount, expected: paragraphs.length, model: request.model });
    }
    logger.info('provider.stream.success', {
      durationMs: Date.now() - startedAt,
      completedCount,
      expected: paragraphs.length,
    });
    return { completedCount, truncated };
  } catch (error) {
    logger.error('provider.stream.failure', { durationMs: Date.now() - startedAt, error });
    if (error instanceof DOMException && error.name === 'AbortError') {
      if (abortCause === 'total') throw new TranslationServiceError('模型流式输出超过 5 分钟绝对上限，已中断。');
      if (abortCause === 'idle') throw new TranslationServiceError('模型流式输出中断：连续 30 秒未收到新内容，请检查模型服务或更换 Endpoint。');
      throw error;
    }
    throw error;
  } finally {
    if (streamTimer !== undefined) globalThis.clearTimeout(streamTimer);
    signal?.removeEventListener('abort', abortFromCaller);
  }
};
