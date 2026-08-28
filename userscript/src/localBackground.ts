/**
 * 本地 background：复刻扩展 background.ts 的消息处理角色。
 *
 * 扩展中这些处理器运行在 service worker；脚本环境没有独立进程，这里在同一闭包内
 * 注册到本地消息总线（busShim）。content 侧模块（trans.ts 等）经 chrome.runtime shim
 * 发出的每条消息，都在此得到与扩展完全一致的处理：
 *   - translate / translate-batch：OpenAI 兼容与传统 MT（DeepL / 腾讯翻译）双后端；
 *   - test-connection / fetch-models：设置面板使用；
 *   - translate-batch-stream 端口：GM 流式传输（onprogress 增量 → 标签流解析器），
 *     管理器不提供增量文本时在同一请求内自动降级为整段解析，渲染结果与非流式一致。
 *
 * 与扩展的差异点仅有一处：无「仅扩展页面可调用」的 sender 校验——本总线位于脚本
 * 闭包内，页面脚本不可达，不存在伪造面。
 */

import {
  normalizeBaseUrl,
  streamTranslateBatch,
  testOpenAICompatibleConnection,
  throwHttpError,
  translateBatchWithOpenAICompatible,
  translateWithOpenAICompatible,
  validateEndpointUrl,
  parseResponseBody,
  extractTaggedTranslations,
  extractTranslationContent,
  extractStreamDelta,
  createTagStreamParser,
  type BatchTranslationRequest,
} from '../../chrome-plugin/src/service/common';
import { buildBatchMessages } from '../../chrome-plugin/src/service/templates';
import { getMtAdapter, type MtTranslationRequest } from '../../chrome-plugin/src/service/mt';
import { getProviderMeta, isMtProviderId, isNoKeyMtProviderId, parseModelsPayload, resolveProviderSettings } from '../../chrome-plugin/src/utils/providers';
import { getConfig, type TranslatorConfig } from '../../chrome-plugin/src/utils/config';
import { logger } from '../../chrome-plugin/src/utils/logger';
import { getGm, hasGmXhr } from './compat/gm';

/** 当前启用服务商是否为传统 MT 后端（DeepL / 腾讯翻译）：无模型、无提示词、无流式。 */
const backendKind = (config: Pick<TranslatorConfig, 'providerId'>): 'openai' | 'mt' =>
  getProviderMeta(config.providerId).kind === 'mt' ? 'mt' : 'openai';

const isMtBackend = (config: Pick<TranslatorConfig, 'providerId'>): boolean => backendKind(config) === 'mt';

/** 由激活服务商的已存凭据构建 MT 适配器运行时（含腾讯 apiSecret/region）。 */
const buildMtRequest = (config: TranslatorConfig): MtTranslationRequest => {
  const runtime = resolveProviderSettings(config, config.providerId);
  return {
    apiKey: runtime.apiKey,
    apiSecret: runtime.apiSecret,
    endpoint: runtime.endpoint,
    region: runtime.region,
    targetLanguage: config.targetLanguage,
  };
};

const MAX_BATCH_PARAGRAPHS = 500;
const MAX_PARAGRAPH_CHARS = 50_000;
const MAX_PAGE_CONTEXT_CHARS = 2_000;

const sanitizeParagraphs = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .slice(0, MAX_BATCH_PARAGRAPHS)
    .map((text) => text.slice(0, MAX_PARAGRAPH_CHARS));
};

const sanitizePageContext = (value: unknown): string =>
  typeof value === 'string' ? value.slice(0, MAX_PAGE_CONTEXT_CHARS) : '';

// ── GM 流式批量翻译（复用扩展的提示词构造、标签流解析器与错误语义） ──

type GmStreamRequest = BatchTranslationRequest;

interface GmStreamHandlers {
  onPartial: (index: number, text: string) => void;
  onParagraph: (index: number, text: string) => void;
}

const gmStreamTranslateBatch = async (
  request: GmStreamRequest,
  handlers: GmStreamHandlers,
  signal?: AbortSignal,
): Promise<{ completedCount: number }> => {
  if (!request.apiKey.trim()) throw new Error('请先在插件设置中填写 API Key。');
  if (!request.endpoint.trim()) throw new Error('请先填写 API Endpoint。');
  if (!request.model.trim()) throw new Error('请先填写模型名称。');
  const paragraphs = request.paragraphs;
  if (paragraphs.length === 0) return { completedCount: 0 };

  const api = getGm();
  const canXhr = hasGmXhr();
  if (!api || !canXhr) {
    // 无 GM 网络能力：直接走非流式批量（fetch shim 内部回退原生 fetch）
    const translations = await translateBatchWithOpenAICompatible({
      ...request,
      paragraphs,
      maxBatchSize: Math.max(paragraphs.length, 10),
    });
    for (let i = 0; i < translations.length; i += 1) {
      if (translations[i]) handlers.onParagraph(i, translations[i]);
    }
    return { completedCount: translations.filter(Boolean).length };
  }
  const controller = new AbortController();
  const startedAt = Date.now();
  const url = `${normalizeBaseUrl(request.endpoint)}/chat/completions`;
  const maxTokens = request.maxTokens ?? 8192;
  const disableReasoning = request.disableReasoning ?? false;
  const requestOverrides = disableReasoning
    ? { enable_thinking: false as const, thinking: { type: 'disabled' as const } }
    : {};
  const context = (request.pageContext ?? '').trim();
  const contextSuffix = context ? `Context for translation: ${context}` : '';
  const parser = createTagStreamParser(paragraphs.length);
  const dispatchEvents = (delta: string): void => {
    for (const event of parser.push(delta)) {
      if (event.completed) handlers.onParagraph(event.completed.index, event.completed.text);
      else if (event.partial) handlers.onPartial(event.partial.index, event.partial.text);
    }
  };
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

  logger.info('provider.stream.start', {
    url,
    model: request.model,
    targetLanguage: request.targetLanguage,
    inputCharacters: paragraphs.join(' ').length,
    maxTokens,
    disableReasoning,
    batchSize: paragraphs.length,
    hasContext: Boolean(context),
    transport: 'gm_xmlhttp_request',
  });

  return new Promise<{ completedCount: number }>((resolve, reject) => {
    let settled = false;
    let sseBuffer = '';
    let lastProgressLength = 0;
    let sawIncrementalText = false;

    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromCaller);
      outcome();
    };

    const timeout = globalThis.setTimeout(() => controller.abort(), 30_000);
    const abortFromCaller = (): void => {
      controller.abort();
      try {
        handle?.abort();
      } catch {
        // 已结束的请求 abort 无害
      }
    };
    if (signal) {
      if (signal.aborted) {
        abortFromCaller();
      } else {
        signal.addEventListener('abort', abortFromCaller, { once: true });
      }
    }

    const finalizeBody = (status: number, bodyText: string, contentType: string): void => {
      if (status < 200 || status >= 300) {
        finish(() => throwHttpError(status, bodyText.slice(0, 300)));
        return;
      }
      // 先冲刷残余缓冲行
      if (sseBuffer) {
        handleSseLine(sseBuffer);
        sseBuffer = '';
      }
      let completedCount = parser.getCompletedCount();
      if (completedCount === 0) {
        // 自动降级：管理器无增量文本或服务商返回整体 JSON/NDJSON，
        // 对完整响应体按扩展的非流式路径解析（parseResponseBody 兼容 SSE/裸 JSON 行）
        const parsed = parseResponseBody(bodyText);
        if (parsed.mode !== 'none') {
          const extraction = extractTranslationContent(parsed.payload);
          if (extraction) {
            const translations = extractTaggedTranslations(extraction.content, paragraphs.length);
            for (let i = 0; i < translations.length; i += 1) {
              if (translations[i]) handlers.onParagraph(i, translations[i]);
            }
            completedCount = translations.filter(Boolean).length;
          }
        }
      }
      logger.info('provider.stream.success', {
        durationMs: Date.now() - startedAt,
        completedCount,
        expected: paragraphs.length,
        incremental: sawIncrementalText,
        contentType,
      });
      finish(() => resolve({ completedCount }));
    };

    let handle: { abort: () => void } | null = null;
    try {
      handle = api.xmlhttpRequest({
        method: 'POST',
        url,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${request.apiKey}`,
        },
        data: JSON.stringify({
          model: request.model,
          temperature: 0,
          max_tokens: maxTokens,
          stream: true,
          ...requestOverrides,
          messages: buildBatchMessages(
            paragraphs,
            request.targetLanguage,
            contextSuffix,
            { promptStyle: request.promptStyle, useCustomPrompt: request.useCustomPrompt, customPrompt: request.customPrompt },
          ),
        }),
        signal: controller.signal,
        onprogress: (response) => {
          const text = response.responseText ?? '';
          if (text.length <= lastProgressLength) return;
          sawIncrementalText = true;
          sseBuffer += text.slice(lastProgressLength);
          lastProgressLength = text.length;
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() ?? '';
          for (const line of lines) handleSseLine(line);
        },
        onload: (response) => {
          finalizeBody(
            response.status,
            response.responseText ?? '',
            parseResponseContentType(response.responseHeaders),
          );
        },
        onerror: () => {
          finish(() => reject(new TypeError('网络请求失败（GM_xmlhttpRequest），请检查接口地址与网络。')));
        },
        onabort: () => {
          finish(() => reject(new DOMException('The operation was aborted.', 'AbortError')));
        },
        ontimeout: () => {
          finish(() => reject(new DOMException('The operation was aborted due to timeout.', 'AbortError')));
        },
      });
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new TypeError('GM_xmlhttpRequest 调用失败。')));
    }
  }).catch((error: unknown) => {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('模型请求超过 30 秒仍未响应，请检查 Endpoint、网络或模型服务。');
    }
    throw error;
  });
};

const parseResponseContentType = (rawHeaders: string | undefined): string => {
  if (!rawHeaders) return '';
  for (const line of rawHeaders.split(/\r?\n/)) {
    const match = /^content-type:\s*(.*)$/i.exec(line.trim());
    if (match) return match[1].trim();
  }
  return '';
};

// ── 消息与端口注册（与 background.ts 行为对齐） ──

interface BackgroundPort {
  name: string;
  postMessage: (message: unknown) => void;
  disconnect?: () => void;
  onMessage: { addListener: (listener: (message: unknown) => void) => void };
  onDisconnect: { addListener: (listener: () => void) => void };
}

interface RuntimeLike {
  onConnect?: { addListener: (listener: (port: BackgroundPort) => void) => void };
  onMessage?: {
    addListener: (
      listener: (
        message: unknown,
        sender: unknown,
        sendResponse: (response: unknown) => void,
      ) => boolean | void,
    ) => void;
  };
}

export const registerLocalBackground = (): void => {
  const runtime = (window as typeof window & { chrome?: { runtime?: RuntimeLike } }).chrome?.runtime;
  if (!runtime) return;

  // 端口流式翻译
  runtime.onConnect?.addListener((port) => {
    if (port.name !== 'translate-batch-stream') return;
    let abortController: AbortController | null = null;
    let disconnected = false;

    const send = (message: unknown): void => {
      if (disconnected) return;
      try {
        port.postMessage(message);
      } catch {
        disconnected = true;
      }
    };

    port.onDisconnect.addListener(() => {
      disconnected = true;
      abortController?.abort();
    });

    port.onMessage.addListener((message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const type = (message as { type?: string }).type;
      if (type !== 'start') return;
      const { paragraphs, pageContext } = message as { type: 'start'; paragraphs: string[]; pageContext?: string };
      const safeParagraphs = sanitizeParagraphs(paragraphs);
      const safeContext = sanitizePageContext(pageContext);
      void (async () => {
        abortController = new AbortController();
        try {
          const config = await getConfig();
          logger.info('background.stream_translation.start', { paragraphCount: safeParagraphs.length, model: config.model });
          const useGmStream = !isMtBackend(config) && hasGmXhr();
          const { completedCount } = useGmStream
            ? await gmStreamTranslateBatch(
                { ...config, paragraphs: safeParagraphs, pageContext: safeContext },
                {
                  onPartial: (index, text) => send({ type: 'partial', index, text }),
                  onParagraph: (index, text) => send({ type: 'paragraph', index, text }),
                },
                abortController!.signal,
              )
            : await streamTranslateBatch(
                { ...config, paragraphs: safeParagraphs, pageContext: safeContext },
                {
                  onPartial: (index, text) => send({ type: 'partial', index, text }),
                  onParagraph: (index, text) => send({ type: 'paragraph', index, text }),
                },
                abortController!.signal,
              );
          logger.info('background.stream_translation.success', { paragraphCount: safeParagraphs.length, completedCount });
          send({ type: 'done', completedCount });
        } catch (error) {
          logger.error('background.stream_translation.failure', { error });
          send({ type: 'error', error: error instanceof Error ? error.message : '流式翻译失败。' });
        }
      })();
    });
  });

  // 单次消息处理
  runtime.onMessage?.addListener((message: unknown, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return undefined;
    const type = (message as { type?: string }).type;
    if (type !== 'translate' && type !== 'translate-batch' && type !== 'test-connection' && type !== 'fetch-models') return undefined;

    logger.info('background.message.received', { type });
    void (async () => {
      try {
        const config = await getConfig();
        if (type === 'fetch-models') {
          const { endpoint, apiKey, kind } = message as { type: 'fetch-models'; endpoint: string; apiKey: string; kind?: string };
          if (kind === 'mt') throw new Error('该服务商无需模型列表（传统翻译 API 无模型）。');
          if (!endpoint?.trim()) throw new Error('请先填写接口地址。');
          validateEndpointUrl(endpoint);
          const url = `${normalizeBaseUrl(endpoint)}/models`;
          logger.info('background.fetch_models.start', { url });
          const modelsResponse = await window.fetch(url, {
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
          });
          if (!modelsResponse.ok) {
            const detail = (await modelsResponse.text()).slice(0, 200);
            throw new Error(`获取模型列表失败 (HTTP ${modelsResponse.status})${detail ? `：${detail}` : ''}`);
          }
          const payload: unknown = await modelsResponse.json();
          const models = parseModelsPayload(payload).slice(0, 100);
          logger.info('background.fetch_models.success', { count: models.length });
          sendResponse({ ok: true, models });
          return;
        }

if (type === 'test-connection') {
          // 只使用消息中显式传入的值，绝不回退到已保存 Key（与扩展同一安全契约）
          const overrides = message as { endpoint?: string; apiKey?: string; apiSecret?: string; region?: string; model?: string; kind?: string; providerId?: string };
          const endpoint = overrides.endpoint?.trim() ?? '';
          const apiKey = overrides.apiKey?.trim() ?? '';
          const model = overrides.model?.trim() ?? '';
          if (!endpoint) throw new Error('请填写接口地址。');
          validateEndpointUrl(endpoint);
          const effective = { ...config, endpoint, apiKey, model };
          logger.info('background.connection_test.start', { model, endpoint, kind: overrides.kind ?? '' });
          // 传统 MT 后端（DeepL / 腾讯翻译 / 微软翻译）：按 providerId 分发到适配器
          if (overrides.kind === 'mt' || overrides.kind === 'deepl') {
            const mtId = overrides.kind === 'mt'
              ? (typeof overrides.providerId === 'string' && isMtProviderId(overrides.providerId) ? overrides.providerId : '')
              : 'deepl';
            if (!mtId) throw new Error('未知的翻译服务。');
            // 微软/谷歌翻译走免密钥端点，不需要 API Key
            if (!apiKey && !isNoKeyMtProviderId(mtId)) throw new Error('请填写 API Key。');
            const adapter = getMtAdapter(mtId);
            const pong = await adapter.testConnection({
              apiKey,
              apiSecret: overrides.apiSecret?.trim() ?? '',
              endpoint,
              region: overrides.region?.trim() ?? undefined,
              targetLanguage: effective.targetLanguage,
            });
            logger.info('background.connection_test.success', { backend: mtId, returnedCharacters: pong.length });
            sendResponse({ ok: true, pong });
            return;
          }
          if (!apiKey) throw new Error('请填写 API Key。');
          const pong = await testOpenAICompatibleConnection(effective);
          logger.info('background.connection_test.success', { returnedCharacters: pong.length });
          sendResponse({ ok: true, pong });
          return;
        }

        if (type === 'translate-batch') {
          const { paragraphs, maxBatchSize, pageContext } = message as { type: 'translate-batch'; paragraphs: string[]; maxBatchSize?: number; pageContext?: string };
          const safeParagraphs = sanitizeParagraphs(paragraphs);
          const safeContext = sanitizePageContext(pageContext);
          logger.info('background.batch_translation.start', { paragraphCount: safeParagraphs.length, model: config.model, maxBatchSize, hasContext: Boolean(safeContext) });
          // 传统 MT 后端：整批直译（无流式、无提示词），由适配器保证 1:1 次序
          if (isMtBackend(config)) {
            const adapter = getMtAdapter(config.providerId);
            const translations = await adapter.translateBatch(safeParagraphs, buildMtRequest(config));
            logger.info('background.batch_translation.success', { backend: config.providerId, paragraphCount: safeParagraphs.length, outputCharacters: translations.join('').length });
            sendResponse({ ok: true, translations });
            return;
          }
          const translations = await translateBatchWithOpenAICompatible({ ...config, paragraphs: safeParagraphs, maxBatchSize, pageContext: safeContext });
          logger.info('background.batch_translation.success', { paragraphCount: safeParagraphs.length, outputCharacters: translations.join('').length });
          sendResponse({ ok: true, translations });
          return;
        }

        const { text } = message as { type: 'translate'; text: string };
        if (typeof text !== 'string' || !text.trim()) throw new Error('翻译内容为空。');
        const safeText = text.slice(0, MAX_PARAGRAPH_CHARS);
        logger.info('background.translation.start', { inputCharacters: safeText.length, model: config.model });
        if (isMtBackend(config)) {
          const adapter = getMtAdapter(config.providerId);
          const translations = await adapter.translateBatch([safeText], buildMtRequest(config));
          const translation = translations[0] ?? '';
          logger.info('background.translation.success', { backend: config.providerId, outputCharacters: translation.length });
          sendResponse({ ok: true, translation });
          return;
        }
        const translation = await translateWithOpenAICompatible({ ...config, text: safeText });
        logger.info('background.translation.success', { outputCharacters: translation.length });
        sendResponse({ ok: true, translation });
      } catch (error) {
        logger.error('background.message.failure', { type, error });
        sendResponse({ ok: false, error: error instanceof Error ? error.message : '操作失败。' });
      }
    })();

    return true;
  });
};
