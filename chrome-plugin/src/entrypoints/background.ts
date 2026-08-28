import { normalizeBaseUrl, streamTranslateBatch, testOpenAICompatibleConnection, translateBatchWithOpenAICompatible, translateWithOpenAICompatible, validateEndpointUrl } from '../service/common';
import { completeWithOpenAICompatible } from '../service/common';
import { getMtAdapter, type MtTranslationRequest } from '../service/mt';
import { SEGMENTATION_SYSTEM_PROMPT } from '../utils/subtitles/ai-segmenter';
import { getProviderMeta, isMtProviderId, isNoKeyMtProviderId, parseModelsPayload, resolveProviderSettings } from '../utils/providers';
import { getConfig, type TranslatorConfig } from '../utils/config';
import { logger } from '../utils/logger';

/** 当前启用服务商的后端类型：传统 MT（DeepL / 腾讯翻译）无模型、无提示词、无流式。 */
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

/** 单次批量/流式翻译的段落上限（content 侧候选上限 100；此处兜底防消息方恶意放大消耗）。 */
const MAX_BATCH_PARAGRAPHS = 500;
const MAX_PARAGRAPH_CHARS = 50_000;
const MAX_PAGE_CONTEXT_CHARS = 2_000;

/** 校验消息中的段落数组：仅接受字符串，限条数与单条长度。 */
const sanitizeParagraphs = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .slice(0, MAX_BATCH_PARAGRAPHS)
    .map((text) => text.slice(0, MAX_PARAGRAPH_CHARS));
};

const sanitizePageContext = (value: unknown): string =>
  typeof value === 'string' ? value.slice(0, MAX_PAGE_CONTEXT_CHARS) : '';

/** 消息是否来自扩展自身页面（options/popup），而非注入到网页的 content script。 */
const isExtensionPageSender = (sender: chrome.runtime.MessageSender): boolean =>
  typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));

export default defineBackground(() => {
  const sendPageCommand = async (
    tabId: number,
    command: 'translate-page' | 'restore-page' | 'stop-translation',
    maxBatchSize?: number,
  ): Promise<unknown> => {
    const tab = await chrome.tabs.get(tabId);
    if (/^(chrome|edge|about|devtools|view-source|file):/i.test(tab.url ?? '')) {
      throw new Error('浏览器内部页面或本地文件不支持翻译，请打开普通网页（http/https）后重试。');
    }
    try {
      return await chrome.tabs.sendMessage(tabId, { type: command, maxBatchSize });
    } catch (firstError) {
      const messageText = firstError instanceof Error ? firstError.message : String(firstError);
      if (!/Receiving end does not exist|Could not establish connection/i.test(messageText)) throw firstError;
      if (!chrome.scripting?.executeScript) {
        throw new Error('当前浏览器不支持脚本注入，请重新加载插件并刷新页面。');
      }
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content-scripts/content.js'] });
      return await chrome.tabs.sendMessage(tabId, { type: command, maxBatchSize });
    }
  };

  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
      // 右键菜单：单一顶级项，点击即翻译当前页；还原入口保留在弹窗/悬浮按钮/快捷键
      chrome.contextMenus.create({
        id: 'moyi-translate',
        title: '墨译 · 翻译当前页',
        contexts: ['page', 'selection'],
      });
    });
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== 'moyi-translate' || !tab || typeof tab.id !== 'number') return;
    void sendPageCommand(tab.id, 'translate-page')
      .then(() => logger.info('background.context_menu.success', { command: 'translate-page', tabId: tab.id }))
      .catch((error) => logger.error('background.context_menu.failure', { command: 'translate-page', error }));
  });

  chrome.commands.onCommand.addListener((command) => {
    if (command !== 'translate-page' && command !== 'restore-page') return;
    void (async () => {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const tabId = tabs[0]?.id;
      if (typeof tabId !== 'number') return;
      try {
        await sendPageCommand(tabId, command);
      } catch (error) {
        logger.error('background.command.failure', { command, error });
      }
    })();
  });

  chrome.runtime.onConnect.addListener((port) => {
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
          const { completedCount } = await streamTranslateBatch(
            { ...config, paragraphs: safeParagraphs, pageContext: safeContext },
            {
              onPartial: (index, text) => send({ type: 'partial', index, text }),
              onParagraph: (index, text) => send({ type: 'paragraph', index, text }),
            },
            abortController.signal,
          );
          logger.info('background.stream_translation.success', { paragraphCount: paragraphs.length, completedCount });
          send({ type: 'done', completedCount });
        } catch (error) {
          logger.error('background.stream_translation.failure', { error });
          send({ type: 'error', error: error instanceof Error ? error.message : '流式翻译失败。' });
        }
      })();
    });
  });

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!message || typeof message !== 'object') return undefined;
    const type = (message as { type?: string }).type;
    if (type !== 'translate' && type !== 'translate-batch' && type !== 'test-connection' && type !== 'fetch-models' && type !== 'page-command' && type !== 'segment-subtitles') return undefined;

    logger.info('background.message.received', { type });
    void (async () => {
      try {
        if (type === 'page-command') {
          if (!isExtensionPageSender(sender)) throw new Error('该操作仅允许从扩展页面发起。');
          const { tabId, command, maxBatchSize } = message as { type: 'page-command'; tabId: number; command: 'translate-page' | 'restore-page' | 'stop-translation'; maxBatchSize?: number };
          if (!Number.isInteger(tabId)) throw new Error('无法找到当前标签页。');
          const result = await sendPageCommand(tabId, command, maxBatchSize);
          logger.info('background.page_command.success', { command, tabId });
          sendResponse(result ?? { ok: true });
          return;
        }

        const config = await getConfig();
        if (type === 'fetch-models') {
          if (!isExtensionPageSender(sender)) throw new Error('该操作仅允许从扩展页面发起。');
          const { endpoint, apiKey, kind } = message as { type: 'fetch-models'; endpoint: string; apiKey: string; kind?: string };
          if (kind === 'mt') throw new Error('该服务商无需模型列表（传统翻译 API 无模型）。');
          if (!endpoint?.trim()) throw new Error('请先填写接口地址。');
          validateEndpointUrl(endpoint);
          const url = `${normalizeBaseUrl(endpoint)}/models`;
          logger.info('background.fetch_models.start', { url });
          const modelsResponse = await fetch(url, {
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
          if (!isExtensionPageSender(sender)) throw new Error('该操作仅允许从扩展页面发起。');
          // 只使用消息中显式传入的值，绝不回退到已保存 Key——否则任意扩展上下文
          // 可用一条消息把用户的真实 Key 发往自己指定的 endpoint。
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

        if (type === 'segment-subtitles') {
          // AI 字幕断句：语言无关，仅要求 OpenAI 兼容服务商；DeepL 直接声明不支持
          const { jsonChunks } = message as { type: 'segment-subtitles'; jsonChunks?: unknown };
          if (
            !Array.isArray(jsonChunks)
            || jsonChunks.length === 0
            || jsonChunks.length > 8
            || jsonChunks.some((chunk) => typeof chunk !== 'string' || chunk.length === 0 || chunk.length > 30_000)
          ) {
            throw new Error('断句请求格式非法。');
          }
          if (isMtBackend(config)) {
            sendResponse({ ok: false, unsupported: true, error: '当前翻译服务（DeepL / 腾讯翻译）无语言模型，不支持 AI 断句（本次使用规则断句）。' });
            return;
          }
          logger.info('background.subtitle_segmentation.start', { chunks: jsonChunks.length, model: config.model });
          let vtt = '';
          for (const chunk of jsonChunks as string[]) {
            const text = await completeWithOpenAICompatible({
              endpoint: config.endpoint,
              apiKey: config.apiKey,
              model: config.model,
              system: SEGMENTATION_SYSTEM_PROMPT,
              user: `Re-segment these word-level subtitle fragments into sentences:\n${chunk}`,
              maxTokens: 8192,
              timeoutMs: 60_000,
            });
            vtt += (vtt ? '\n' : '') + text.trim();
          }
          logger.info('background.subtitle_segmentation.success', { outputCharacters: vtt.length });
          sendResponse({ ok: true, vtt });
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
});
