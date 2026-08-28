import { findTranslationCandidates } from '../../translation-core';
import type { ElementTypography } from '../../translation-core/typography';
import { extractPageContext, requestBatchTranslation, requestTranslation, streamBatchTranslation, type StreamHandle } from '../../utils/translateApi';
import { getConfig } from '../../utils/config';
import { getProviderMeta } from '../../utils/providers';
import { beginTranslation, getActiveElements, getTranslationState } from './translationState';
import { renderPartialTranslation, renderTranslation, renderTranslationError, restoreTranslation } from './translationRenderer';
import { BatchingScheduler } from '../../utils/concurrency';
import { logger } from '../../utils/logger';
import { cacheKey, loadTranslationCache, saveTranslationCache, type TranslationCache } from './translationCache';

const BATCH_SIZE = 5;
const CONCURRENCY = 3;
const VIEWPORT_AHEAD = 300;

let pageGeneration = 0;
let pageContext = '';
let translatedCount = 0;
let activeScheduler: BatchingScheduler<TranslationItem> | null = null;
let activeObserver: IntersectionObserver | null = null;
const activeStreams = new Set<StreamHandle>();

// ── 译文缓存会话：一次读入、命中直接渲染，结束时一次写回新译文 ──
let sessionCache: TranslationCache | null = null;
let sessionLanguage = '';
let pendingCacheWrites: { language: string; text: string; translation: string }[] = [];

const flushCacheWrites = (): void => {
  if (!sessionCache || pendingCacheWrites.length === 0) return;
  const writes = pendingCacheWrites;
  pendingCacheWrites = [];
  void saveTranslationCache(sessionCache, writes);
};

const startCacheSession = async (targetLanguage: string): Promise<void> => {
  sessionLanguage = targetLanguage;
  sessionCache = await loadTranslationCache();
  pendingCacheWrites = [];
};

const updatePageContext = (): void => {
  pageContext = extractPageContext();
};

const cancelInFlight = (): void => {
  activeObserver?.disconnect();
  activeObserver = null;
  for (const stream of activeStreams) stream.abort();
  activeStreams.clear();
  activeScheduler?.clear();
  activeScheduler = null;
};

export const restoreAllTranslations = (): void => {
  pageGeneration += 1;
  cancelInFlight();
  flushCacheWrites();
  // 还原完全由翻译状态驱动：每个活动元素恢复原文、移除译文并清空状态。
  // 不做「删除页面上所有 owned 节点」的无差别兜底——替换模式下隐藏原文的
  // 包装节点也带 owned 标记，一旦它未被上层清理，兜底删除会连同原文一起
  // 物理删除且无法恢复。
  for (const element of getActiveElements()) restoreTranslation(element);
};

/** 停止在途翻译：作废未完成的批次，保留已渲染的译文 */
export const stopTranslation = (): void => {
  pageGeneration += 1;
  cancelInFlight();
  flushCacheWrites();
};

interface TranslationItem {
  text: string;
  element: HTMLElement;
  typography: ElementTypography;
}

/** 当前翻译会话的后端类型（OpenAI 兼容 / DeepL、腾讯等传统 MT）。 */
let sessionBackend: 'openai' | 'mt' = 'openai';

const runBatch = async (items: TranslationItem[], generation: number): Promise<void> => {
  const states = items.map((item) => beginTranslation(item.element, item.text, item.typography));

  // 传统 MT（DeepL / 腾讯）：无流式与提示词，整批发送、按序逐段渲染
  if (sessionBackend === 'mt') {
    try {
      const translations = await requestBatchTranslation(items.map((item) => item.text), items.length, pageContext);
      if (generation !== pageGeneration) return;
      for (let i = 0; i < items.length; i += 1) {
        const translation = translations[i]?.trim();
        if (!translation) {
          renderTranslationError(items[i].element, '服务未返回该段落译文', states[i].generation);
          continue;
        }
        if (renderTranslation(items[i].element, translation, states[i].generation, items[i].typography)) {
          translatedCount += 1;
          pendingCacheWrites.push({ language: sessionLanguage, text: items[i].text, translation });
        }
      }
    } catch (error) {
      if (generation !== pageGeneration) return;
      for (let i = 0; i < items.length; i += 1) {
        renderTranslationError(items[i].element, error instanceof Error ? error.message : '未知错误', states[i].generation);
      }
    }
    return;
  }

  const received = new Set<number>();

  if (items.length === 1) {
    try {
      const translation = await requestTranslation(items[0].text);
      if (generation === pageGeneration) {
        if (renderTranslation(items[0].element, translation, states[0].generation, items[0].typography)) {
          translatedCount += 1;
          pendingCacheWrites.push({ language: sessionLanguage, text: items[0].text, translation });
        }
      }
    } catch (error) {
      if (generation === pageGeneration) {
        renderTranslationError(items[0].element, error instanceof Error ? error.message : '未知错误', states[0].generation);
      }
    }
    return;
  }

  await new Promise<void>((resolve) => {
    let handle!: StreamHandle;
    handle = streamBatchTranslation(
      items.map((item) => item.text),
      {
        pageContext,
        onPartial: (index, text) => {
          if (generation !== pageGeneration) return;
          renderPartialTranslation(items[index].element, text, states[index].generation, items[index].typography);
        },
        onParagraph: (index, text) => {
          if (generation !== pageGeneration) return;
          received.add(index);
          if (renderTranslation(items[index].element, text, states[index].generation, items[index].typography)) {
            translatedCount += 1;
            pendingCacheWrites.push({ language: sessionLanguage, text: items[index].text, translation: text });
            logger.debug('content.paragraph.success', { index: translatedCount, outputCharacters: text.length });
          }
        },
        onError: (error) => {
          activeStreams.delete(handle);
          if (generation === pageGeneration) {
            logger.error('content.stream_batch.failure', { size: items.length, error });
            for (let i = 0; i < items.length; i += 1) {
              if (!received.has(i)) {
                renderTranslationError(items[i].element, error, states[i].generation);
              }
            }
          }
          resolve();
        },
        onDone: () => {
          activeStreams.delete(handle);
          if (generation === pageGeneration) {
            for (let i = 0; i < items.length; i += 1) {
              if (!received.has(i)) {
                renderTranslationError(items[i].element, '模型未返回该段落译文', states[i].generation);
              }
            }
          }
          resolve();
        },
      },
    );
    activeStreams.add(handle);
  });
};

const isNearViewport = (element: HTMLElement): boolean => {
  const rect = element.getBoundingClientRect();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  return rect.bottom >= -VIEWPORT_AHEAD && rect.top <= viewportHeight + VIEWPORT_AHEAD;
};

const observeOffscreen = (
  items: TranslationItem[],
  onVisible: (batch: TranslationItem[]) => void,
): IntersectionObserver | null => {
  if (typeof IntersectionObserver === 'undefined') return null;
  const pending = new Map<HTMLElement, TranslationItem>();
  for (const item of items) pending.set(item.element, item);

  const observer = new IntersectionObserver((entries) => {
    const visible: TranslationItem[] = [];
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const item = pending.get(entry.target as HTMLElement);
      if (!item) continue;
      pending.delete(entry.target as HTMLElement);
      observer.unobserve(entry.target);
      visible.push(item);
    }
    if (visible.length > 0) onVisible(visible);
  }, { rootMargin: `${VIEWPORT_AHEAD}px 0px` });

  for (const item of items) observer.observe(item.element);
  return observer;
};

export const translatePage = async (maxBatchSize?: number): Promise<{ translated: number; skipped: number; deferred: number; cached?: number }> => {
  updatePageContext();
  const generation = ++pageGeneration;
  cancelInFlight();

  // 缓存会话：按当前目标语言读入整表；已缓存的段落直接渲染，不再请求模型
  const config = await getConfig();
  await startCacheSession(config.targetLanguage);
  sessionBackend = getProviderMeta(config.providerId).kind === 'mt' ? 'mt' : 'openai';

  const candidates = findTranslationCandidates(document.body, 100);
  logger.info('content.page_translation.start', { generation, candidates: candidates.length, url: location.href });

  translatedCount = 0;
  let skipped = 0;
  let cachedCount = 0;
  const queueable: TranslationItem[] = [];
  for (const candidate of candidates) {
    if (getTranslationState(candidate.element)?.phase === 'translated') {
      skipped += 1;
      continue;
    }
    if (sessionCache) {
      const cached = sessionCache[cacheKey(sessionLanguage, candidate.text)];
      if (cached?.t) {
        const state = beginTranslation(candidate.element, candidate.text, candidate.typography);
        renderTranslation(candidate.element, cached.t, state.generation, candidate.typography);
        translatedCount += 1;
        cachedCount += 1;
        continue;
      }
    }
    queueable.push({ text: candidate.text, element: candidate.element, typography: candidate.typography });
  }

  const visible: TranslationItem[] = [];
  const offscreen: TranslationItem[] = [];
  for (const item of queueable) {
    if (isNearViewport(item.element)) visible.push(item);
    else offscreen.push(item);
  }

  const effectiveBatchSize = Math.max(1, Math.min(maxBatchSize ?? BATCH_SIZE, 10));
  const scheduler = new BatchingScheduler<TranslationItem>({
    batchSize: effectiveBatchSize,
    concurrency: CONCURRENCY,
    runBatch: (items) => runBatch(items, generation),
  });
  activeScheduler = scheduler;

  let scrollEnqueued = 0;
  scheduler.enqueue(visible);

  if (offscreen.length > 0) {
    const observer = observeOffscreen(offscreen, (batch) => {
      if (generation !== pageGeneration) return;
      scrollEnqueued += batch.length;
      scheduler.enqueue(batch);
    });
    if (observer) {
      activeObserver = observer;
    } else {
      scheduler.enqueue(offscreen);
      scrollEnqueued = offscreen.length;
    }
  }

  await scheduler.waitForIdle();
  flushCacheWrites();

  const deferred = Math.max(0, offscreen.length - scrollEnqueued);
  logger.info('content.page_translation.complete', { generation, translated: translatedCount, cached: cachedCount, skipped, deferred });
  return { translated: translatedCount, skipped, deferred, cached: cachedCount };
};
