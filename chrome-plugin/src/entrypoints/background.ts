import { normalizeBaseUrl, streamTranslateBatch, testOpenAICompatibleConnection, translateBatchWithOpenAICompatible, translateWithOpenAICompatible, validateEndpointUrl } from '../service/common';
import { completeWithOpenAICompatible } from '../service/common';
import { getMtAdapter, type MtTranslationRequest } from '../service/mt';
import { SEGMENTATION_SYSTEM_PROMPT } from '../utils/subtitles/ai-segmenter';
import { getProviderMeta, isMtProviderId, isNoKeyMtProviderId, parseModelsPayload, resolveProviderSettings } from '../utils/providers';
import { describeOllamaAccessError, isOllamaProviderId, prepareExtensionProviderConfig, prepareExtensionRequestApiKey } from '../utils/extensionProviders';
import { getConfig, type TranslatorConfig } from '../utils/config';
import { applyGlossaryReplacements } from '../utils/glossary';
import { fetchRuleRepository } from '../utils/ruleRepository';
import { exportVocabToAnki } from '../utils/anki';
import { savePickedElement } from '../utils/pickedElement';
import { EDGE_TTS_VOICES_ENDPOINT, bytesToBase64, synthesizeEdgeSpeech, type EdgeVoice } from '../utils/edgeTts';
import {
  FOLLOWUP_SYSTEM_SUFFIX,
  buildExplainSystemPrompt,
  buildExplainUserPrompt,
  buildLookupSystemPrompt,
  buildLookupUserPrompt,
  classifyLookupKind,
  normalizeSelectionText,
  parseExplainResponse,
  parseLookupResponse,
  sanitizeExplainLevel,
} from '../utils/selectionLookup';
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

/** 跨批上文：最多 3 段、单段 ≤800 字符（与 templates 上文块契约一致；只入 prompt 不入缓存）。 */
const sanitizePrecedingParagraphs = (value: unknown): string[] =>
  sanitizeParagraphs(value).slice(-3).map((text) => text.slice(0, 800));

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
      const { paragraphs, pageContext, precedingParagraphs } = message as { type: 'start'; paragraphs: string[]; pageContext?: string; precedingParagraphs?: string[] };
      const safeParagraphs = sanitizeParagraphs(paragraphs);
      const safeContext = sanitizePageContext(pageContext);
      const safePreceding = sanitizePrecedingParagraphs(precedingParagraphs);
      void (async () => {
        abortController = new AbortController();
        let providerId = '';
        try {
          const config = await getConfig();
          providerId = config.providerId;
          const requestConfig = prepareExtensionProviderConfig(config);
          logger.info('background.stream_translation.start', { paragraphCount: safeParagraphs.length, model: requestConfig.model });
          const { completedCount, truncated } = await streamTranslateBatch(
            { ...requestConfig, paragraphs: safeParagraphs, pageContext: safeContext, precedingParagraphs: safePreceding },
            {
              onPartial: (index, text) => send({ type: 'partial', index, text }),
              onParagraph: (index, text) => send({ type: 'paragraph', index, text }),
            },
            abortController.signal,
          );
          logger.info('background.stream_translation.success', { paragraphCount: paragraphs.length, completedCount, truncated });
          send({ type: 'done', completedCount, truncated });
        } catch (error) {
          logger.error('background.stream_translation.failure', { error });
          const message = error instanceof Error ? error.message : '流式翻译失败。';
          send({ type: 'error', error: describeOllamaAccessError(providerId, message, chrome.runtime.id) });
        }
      })();
    });
  });

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!message || typeof message !== 'object') return undefined;
    const type = (message as { type?: string }).type;
    if (type !== 'translate' && type !== 'translate-batch' && type !== 'test-connection' && type !== 'fetch-models' && type !== 'page-command' && type !== 'segment-subtitles' && type !== 'lookup-word' && type !== 'explain-word' && type !== 'fetch-rule-repository' && type !== 'edge-tts-speak' && type !== 'edge-tts-voices' && type !== 'anki-export' && type !== 'element-picker-start') return undefined;

    logger.info('background.message.received', { type });
    void (async () => {
      // 错误提示需要知道当前服务商（Ollama 的 403 有定向指引），逐分支登记
      let activeProviderId = '';
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
          const { endpoint, apiKey, kind, providerId } = message as { type: 'fetch-models'; endpoint: string; apiKey: string; kind?: string; providerId?: string };
          activeProviderId = typeof providerId === 'string' ? providerId : '';
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
          activeProviderId = overrides.providerId ?? '';
          const endpoint = overrides.endpoint?.trim() ?? '';
          const apiKey = overrides.apiKey?.trim() ?? '';
          const model = overrides.model?.trim() ?? '';
          if (!endpoint) throw new Error('请填写接口地址。');
          validateEndpointUrl(endpoint);
          const effective = {
            ...config,
            endpoint,
            apiKey: prepareExtensionRequestApiKey(overrides.providerId ?? '', apiKey),
            model,
          };
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
          if (!apiKey && !isOllamaProviderId(overrides.providerId ?? '')) throw new Error('请填写 API Key。');
          const pong = await testOpenAICompatibleConnection(effective);
          logger.info('background.connection_test.success', { returnedCharacters: pong.length });
          sendResponse({ ok: true, pong });
          return;
        }

        if (type === 'translate-batch') {
          activeProviderId = config.providerId;
          const { paragraphs, maxBatchSize, pageContext, precedingParagraphs } = message as { type: 'translate-batch'; paragraphs: string[]; maxBatchSize?: number; pageContext?: string; precedingParagraphs?: string[] };
          const safeParagraphs = sanitizeParagraphs(paragraphs);
          const safeContext = sanitizePageContext(pageContext);
          const safePreceding = sanitizePrecedingParagraphs(precedingParagraphs);
          logger.info('background.batch_translation.start', { paragraphCount: safeParagraphs.length, model: config.model, maxBatchSize, hasContext: Boolean(safeContext) });
          // 传统 MT 后端：整批直译（无流式、无提示词），由适配器保证 1:1 次序
          if (isMtBackend(config)) {
            const adapter = getMtAdapter(config.providerId);
            const translations = applyGlossaryReplacements(
              await adapter.translateBatch(safeParagraphs, buildMtRequest(config)),
              config.glossary,
            );
            logger.info('background.batch_translation.success', { backend: config.providerId, paragraphCount: safeParagraphs.length, outputCharacters: translations.join('').length });
            sendResponse({ ok: true, translations });
            return;
          }
          const requestConfig = prepareExtensionProviderConfig(config);
          const translations = await translateBatchWithOpenAICompatible({ ...requestConfig, paragraphs: safeParagraphs, maxBatchSize, pageContext: safeContext, precedingParagraphs: safePreceding });
          logger.info('background.batch_translation.success', { paragraphCount: safeParagraphs.length, outputCharacters: translations.join('').length });
          sendResponse({ ok: true, translations });
          return;
        }

        if (type === 'segment-subtitles') {
          activeProviderId = config.providerId;
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
          const requestConfig = prepareExtensionProviderConfig(config);
          let vtt = '';
          for (const chunk of jsonChunks as string[]) {
            const text = await completeWithOpenAICompatible({
              endpoint: requestConfig.endpoint,
              apiKey: requestConfig.apiKey,
              model: requestConfig.model,
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

        if (type === 'element-picker-start') {
          // 拾取器只能作用于普通网页：选当前窗口里最近访问的非扩展页
          if (!isExtensionPageSender(sender)) throw new Error('该操作仅允许从扩展页面发起。');
          const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabs = active ? [active] : await chrome.tabs.query({ currentWindow: true });
          const target = tabs.find((t) => t.id !== undefined && /^https?:/.test(t.url ?? '') && !t.url?.startsWith(chrome.runtime.getURL('')));
          if (!target?.id) {
            sendResponse({ ok: false, error: '未找到目标网页：请先打开要拾取元素的页面，再回到设置页点「拾取元素」。' });
            return;
          }
          await chrome.tabs.sendMessage(target.id, { type: 'element-picker-start' });
          sendResponse({ ok: true, tabId: target.id, url: target.url });
          return;
        }

        if (type === 'anki-export') {
          // 生词本 → AnkiConnect（localhost 只能由扩展侧发起）
          const { entries } = message as { entries?: unknown };
          if (!Array.isArray(entries) || entries.length === 0) throw new Error('没有可导出的生词。');
          if (entries.length > 1000) throw new Error('单次最多导出 1000 条，请先分批。');
          const clean = entries.slice(0, 1000).map((raw) => {
            const e = (raw ?? {}) as Record<string, unknown>;
            const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
            return { word: str(e.word, 200), translation: str(e.translation, 500), context: str(e.context, 1000), pageTitle: str(e.pageTitle, 200), url: str(e.url, 500), createdAt: typeof e.createdAt === 'number' ? e.createdAt : 0 };
          }).filter((e) => e.word);
          const result = await exportVocabToAnki(clean);
          logger.info('background.anki_export.success', { entries: clean.length, added: result.added });
          sendResponse({ ok: true, ...result });
          return;
        }

        if (type === 'edge-tts-speak') {
          // Edge 云端语音：WebSocket 只能在扩展侧发起（内容脚本受页面 CSP/CORS 管辖）
          if (!isExtensionPageSender(sender) && (sender.url?.startsWith('http') ?? true)) {
            // 内容脚本也允许（词卡在页面里），但仅接受两个受控字段
          }
          const { text, voice, rate } = message as { text?: unknown; voice?: unknown; rate?: unknown };
          if (typeof text !== 'string' || !text.trim()) throw new Error('没有可朗读的内容。');
          if (typeof voice !== 'string' || !/^[a-z]{2,3}(-[A-Za-z]+)+$/.test(voice)) throw new Error('云端音色标识无效。');
          const audio = await synthesizeEdgeSpeech({ text: text.slice(0, 2000), voice, rate: typeof rate === 'number' ? rate : 1 });
          logger.info('background.edge_tts.success', { voice, bytes: audio.byteLength });
          sendResponse({ ok: true, audio: bytesToBase64(audio) });
          return;
        }

        if (type === 'edge-tts-voices') {
          // 音色列表：仅扩展页可拉取（设置页用），8 秒超时
          if (!isExtensionPageSender(sender)) throw new Error('该操作仅允许从扩展页面发起。');
          const controller = new AbortController();
          const timer = globalThis.setTimeout(() => controller.abort(), 8000);
          try {
            const response = await fetch(EDGE_TTS_VOICES_ENDPOINT, { signal: controller.signal });
            if (!response.ok) throw new Error(`音色列表拉取失败（HTTP ${response.status}）。`);
            const voices = (await response.json()) as EdgeVoice[];
            sendResponse({ ok: true, voices: Array.isArray(voices) ? voices.slice(0, 200) : [] });
          } finally {
            globalThis.clearTimeout(timer);
          }
          return;
        }

        if (type === 'lookup-word') {
          activeProviderId = config.providerId;
          // 划词查词：非流式小补全；与 AI 断句同走 completeWithOpenAICompatible 通道。
          const { text } = message as { type: 'lookup-word'; text?: unknown };
          const query = typeof text === 'string' ? normalizeSelectionText(text) : null;
          if (!query) throw new Error('没有可查询的划词内容。');
          if (isMtBackend(config)) {
            sendResponse({ ok: false, unsupported: true, error: '当前翻译服务（DeepL / 腾讯 / 微软 / 谷歌）无语言模型，划词查词需在设置中配置 AI 服务商。' });
            return;
          }
          const requestConfig = prepareExtensionProviderConfig(config);
          logger.info('background.lookup.start', { characters: query.length, model: requestConfig.model });
          const raw = await completeWithOpenAICompatible({
            endpoint: requestConfig.endpoint,
            apiKey: requestConfig.apiKey,
            model: requestConfig.model,
            system: buildLookupSystemPrompt(config.targetLanguage),
            user: buildLookupUserPrompt(query, classifyLookupKind(query)),
            // 选段可达 500 字符，输出含释义+例句，800 tokens 偏紧
            maxTokens: 1200,
            timeoutMs: 30_000,
          });
          logger.info('background.lookup.success', { outputCharacters: raw.length });
          sendResponse({ ok: true, result: parseLookupResponse(query, raw) });
          return;
        }

        if (type === 'fetch-rule-repository') {
          // 规则仓库拉取：只有扩展页（设置页）可发起——页面拿不到我们的网络身份
          if (!isExtensionPageSender(sender)) throw new Error('该操作仅允许从扩展页面发起。');
          const { url } = message as { type: 'fetch-rule-repository'; url?: unknown };
          if (typeof url !== 'string' || !url.trim()) throw new Error('请填写规则仓库地址。');
          const rules = await fetchRuleRepository(url);
          logger.info('background.rule_repo.success', { rules: rules.length });
          sendResponse({ ok: true, rules, fetchedAt: Date.now() });
          return;
        }

        if (type === 'explain-word') {
          activeProviderId = config.providerId;
          // 阅读卡详解/追问：与查词同通道（openai 族非流式），历史仅透传不落盘
          const request = message as {
            text?: unknown; level?: unknown; context?: unknown; followup?: unknown;
            history?: unknown;
          };
          const query = typeof request.text === 'string' ? normalizeSelectionText(request.text) : null;
          if (!query) throw new Error('没有可讲解的划词内容。');
          if (isMtBackend(config)) {
            sendResponse({ ok: false, unsupported: true, error: '当前翻译服务无语言模型，阅读卡详解需在设置中配置 AI 服务商。' });
            return;
          }
          const level = sanitizeExplainLevel(request.level);
          const context = typeof request.context === 'string' ? request.context.slice(0, 800) : '';
          const history = Array.isArray(request.history)
            ? request.history
                .filter((turn): turn is { role: 'user' | 'assistant'; content: string } =>
                  Boolean(turn) && typeof turn === 'object'
                  && ((turn as { role?: unknown }).role === 'user' || (turn as { role?: unknown }).role === 'assistant')
                  && typeof (turn as { content?: unknown }).content === 'string')
                .slice(-8)
                .map((turn) => ({ role: turn.role, content: turn.content.slice(0, 1000) }))
            : [];
          const requestConfig = prepareExtensionProviderConfig(config);
          const system = buildExplainSystemPrompt(config.targetLanguage)
            + (request.followup === true ? FOLLOWUP_SYSTEM_SUFFIX : '');
          logger.info('background.explain.start', { characters: query.length, level, followup: request.followup === true, turns: history.length });
          const raw = await completeWithOpenAICompatible({
            endpoint: requestConfig.endpoint,
            apiKey: requestConfig.apiKey,
            model: requestConfig.model,
            system,
            user: buildExplainUserPrompt(query, level, context),
            history,
            maxTokens: 1600,
            timeoutMs: 45_000,
          });
          logger.info('background.explain.success', { outputCharacters: raw.length });
          sendResponse({ ok: true, result: parseExplainResponse(raw) });
          return;
        }

        const { text, precedingParagraphs } = message as { type: 'translate'; text: string; precedingParagraphs?: string[] };
        activeProviderId = config.providerId;
        if (typeof text !== 'string' || !text.trim()) throw new Error('翻译内容为空。');
        const safeText = text.slice(0, MAX_PARAGRAPH_CHARS);
        const safePreceding = sanitizePrecedingParagraphs(precedingParagraphs);
        logger.info('background.translation.start', { inputCharacters: safeText.length, model: config.model });
if (isMtBackend(config)) {
            const adapter = getMtAdapter(config.providerId);
            const translations = applyGlossaryReplacements(
              await adapter.translateBatch([safeText], buildMtRequest(config)),
              config.glossary,
            );
            const translation = translations[0] ?? '';
            logger.info('background.translation.success', { backend: config.providerId, outputCharacters: translation.length });
            sendResponse({ ok: true, translation });
            return;
          }
        const requestConfig = prepareExtensionProviderConfig(config);
        const translation = await translateWithOpenAICompatible({ ...requestConfig, text: safeText, precedingParagraphs: safePreceding });
        logger.info('background.translation.success', { outputCharacters: translation.length });
        sendResponse({ ok: true, translation });
      } catch (error) {
        logger.error('background.message.failure', { type, error });
        const errorText = error instanceof Error ? error.message : '操作失败。';
        sendResponse({ ok: false, error: describeOllamaAccessError(activeProviderId, errorText, chrome.runtime.id) });
      }
    })();

    return true;
  });
});
