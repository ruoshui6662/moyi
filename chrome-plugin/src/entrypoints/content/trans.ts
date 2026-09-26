import { findTranslationCandidates, type TranslationCandidate } from '../../translation-core';
import type { ElementTypography } from '../../translation-core/typography';
import { extractPageContext, requestBatchTranslation, requestTranslation, streamBatchTranslation, type StreamHandle } from '../../utils/translateApi';
import { getConfig } from '../../utils/config';
import { getProviderMeta } from '../../utils/providers';
import { beginTranslation, getActiveElements, getTranslationState } from './translationState';
import { renderPartialTranslation, renderTranslation, renderTranslationError, restoreTranslation } from './translationRenderer';
import { BatchingScheduler } from '../../utils/concurrency';
import type { CompiledRuleSet } from '../../utils/siteRules';
import { EMPTY_RULE_SET } from '../../utils/siteRules';
import { logger } from '../../utils/logger';
import { cacheKey, loadTranslationCache, saveTranslationCache, type TranslationCache } from './translationCache';

/** 单批段落数上限（动态装箱）：字符预算（6000）为主约束、条数为硬上限——
 *  短段落长文下批越大往返越少（请求数 ≈ 段数÷批上限），长段落由预算自动缩批；
 *  并发仍为 3。输出侧安全网不变：max_tokens=8192 + finish_reason=length 截断检测。 */
export const DEFAULT_MAX_BATCH_SIZE = 16;
const CONCURRENCY = 3;
/** 跨批上文窗口：同文档相邻已入队原文段，注入 prompt 保持术语/指代一致。 */
const CONTEXT_PARAGRAPHS = 3;
const VIEWPORT_AHEAD = 300;
/** OpenAI 后端单批输入字符预算：译文输出与输入近似等长，多段长文本成批
 *  会顶穿 max_tokens=8192 被 finish_reason=length 截断（"翻一半断掉"的根因之一）。
 *  MT 适配器自带字节预算，不走此约束。 */
const MAX_BATCH_INPUT_CHARS = 6000;
/** 单次候选扫描上限（长文超出部分由滚动节流补扫逐步覆盖）。 */
const MAX_CANDIDATES_PER_SCAN = 100;
/** 预取窗口：视口下方 1400px（约两屏）提前入队——成本约 +15~25%，换掉绝大部分滚动延迟。 */
const PREFETCH_AHEAD = 1400;
/** 滚动补扫节流间隔。 */
const RESCAN_THROTTLE_MS = 400;

let pageGeneration = 0;
let pageContext = '';
let translatedCount = 0;
/** 入队序号与原文登记表：上下文提取用（enqueue 顺序 ≈ 文档顺序）。
 *  缓存命中段落不入队也不登记——上文窗口基于本会话实际翻译的段落。 */
let enqueueSeq = 0;
let sessionTexts: string[] = [];
/** 当前会话的站点规则集：由 content/main 依据配置+订阅缓存编译后注入（空集=默认行为）。 */
let sessionRuleSet: CompiledRuleSet = EMPTY_RULE_SET;
let activeScheduler: BatchingScheduler<TranslationItem> | null = null;
let activeOffscreen: OffscreenController | null = null;
/** 本会话已发现的候选（初始扫描 + 滚动补扫）：补扫时交给引擎跳过，防止重复入队与嵌套重译。 */
let sessionKnown: Set<HTMLElement> | null = null;
/** 滚动补扫监听的清理句柄（停止/还原/重新翻译时移除）。 */
let rescanCleanup: (() => void) | null = null;
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
/** 供 content/main 在 pagehide 时尽力刷写：中途关标签/跳转不丢已翻结果，回访直接命中缓存。 */
export const flushPendingCacheWrites = (): void => flushCacheWrites();

const startCacheSession = async (targetLanguage: string): Promise<void> => {
  sessionLanguage = targetLanguage;
  sessionCache = await loadTranslationCache();
  pendingCacheWrites = [];
};

const updatePageContext = (): void => {
  pageContext = extractPageContext();
};

/** 已翻译跳过、缓存命中直接渲染并返回 null，否则产出可入队项。
 *  初始扫描与长文滚动补扫共用，保证两条路径的去重/缓存语义一致。 */
const acceptCandidate = (
  candidate: TranslationCandidate,
): { item: TranslationItem | null; outcome: 'skip' | 'cached' | 'queue' } => {
  if (getTranslationState(candidate.element)?.phase === 'translated') {
    return { item: null, outcome: 'skip' };
  }
  if (sessionCache) {
    const cached = sessionCache[cacheKey(sessionLanguage, candidate.text)];
    if (cached?.t) {
      const state = beginTranslation(candidate.element, candidate.text, candidate.typography);
      renderTranslation(candidate.element, cached.t, state.generation, candidate.typography);
      return { item: null, outcome: 'cached' };
    }
  }
  return {
    item: { text: candidate.text, element: candidate.element, typography: candidate.typography, seq: -1 },
    outcome: 'queue',
  };
};

const cancelInFlight = (): void => {
  activeOffscreen?.disconnect();
  activeOffscreen = null;
  rescanCleanup?.();
  rescanCleanup = null;
  sessionKnown = null;
  enqueueSeq = 0;
  sessionTexts = [];
  for (const stream of activeStreams) stream.abort();
  activeStreams.clear();
  activeScheduler?.clear();
  activeScheduler = null;
};

/** 批首段之前登记的相邻原文（末 CONTEXT_PARAGRAPHS 段，用于跨批上下文）。 */
const precedingFor = (seq: number): string[] => {
  if (seq < 0) return [];
  return sessionTexts.slice(Math.max(0, seq - CONTEXT_PARAGRAPHS), seq);
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
  /** 入队序号（enqueueItems 赋值；-1 为未入队哨兵）。 */
  seq: number;
}

/** 视口外内容的双窗口观察器：近窗口到达插队、预取窗口排队；支持补扫追加新候选。 */
interface OffscreenController {
  observeMore: (items: TranslationItem[]) => void;
  disconnect: () => void;
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
      const translation = await requestTranslation(items[0].text, precedingFor(items[0].seq));
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
        precedingParagraphs: precedingFor(items[0].seq),
        // 让 background 保持本批整体（≤上限），不在其内部按 10 再切
        maxBatchSize: DEFAULT_MAX_BATCH_SIZE,
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
        onDone: (_completedCount, truncated) => {
          activeStreams.delete(handle);
          if (generation === pageGeneration) {
            for (let i = 0; i < items.length; i += 1) {
              if (!received.has(i)) {
                renderTranslationError(
                  items[i].element,
                  truncated ? '译文被服务商输出上限截断（finish_reason=length），该段未完整返回' : '模型未返回该段落译文',
                  states[i].generation,
                );
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
  onEager: (batch: TranslationItem[]) => void,
  onPrefetch: (batch: TranslationItem[]) => void,
): OffscreenController | null => {
  if (typeof IntersectionObserver === 'undefined') return null;
  const pending = new Map<HTMLElement, TranslationItem>();
  const self: { eager?: IntersectionObserver; prefetch?: IntersectionObserver } = {};

  /** 取走命中的项并从两个观察器上解除监听（pending Map 兼作两窗去重）。 */
  const take = (entries: IntersectionObserverEntry[]): TranslationItem[] => {
    const hit: TranslationItem[] = [];
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const item = pending.get(entry.target as HTMLElement);
      if (!item) continue;
      pending.delete(entry.target as HTMLElement);
      self.eager?.unobserve(entry.target);
      self.prefetch?.unobserve(entry.target);
      hit.push(item);
    }
    return hit;
  };

  // 近窗口（视口四周 VIEWPORT_AHEAD）：用户正在到达 → 插到队首，压过预取积压
  self.eager = new IntersectionObserver((entries) => {
    const hit = take(entries);
    if (hit.length > 0) onEager(hit);
  }, { rootMargin: `${VIEWPORT_AHEAD}px 0px` });
  // 预取窗口（下方 PREFETCH_AHEAD，约两屏）：正常入队；FIFO 按文档顺序天然服务向下滚动
  self.prefetch = new IntersectionObserver((entries) => {
    const hit = take(entries);
    if (hit.length > 0) onPrefetch(hit);
  }, { rootMargin: `${VIEWPORT_AHEAD}px 0px ${PREFETCH_AHEAD}px 0px` });

  const observeMore = (more: TranslationItem[]): void => {
    for (const item of more) {
      pending.set(item.element, item);
      self.eager?.observe(item.element);
      self.prefetch?.observe(item.element);
    }
  };
  observeMore(items);

  return {
    observeMore,
    disconnect: () => {
      self.eager?.disconnect();
      self.prefetch?.disconnect();
      pending.clear();
    },
  };
};

/** 滚动节流补扫：候选单次上限 MAX_CANDIDATES_PER_SCAN，长文第 101+ 段靠它逐步发现。
 *  新发现的近窗口项插队入队；其余交给双观察器——到达近窗口即抢占，落入预取窗口即排队。 */
const startRescan = (
  generation: number,
  enqueueItems: (items: TranslationItem[], options?: { front?: boolean }) => void,
  controller: OffscreenController | null,
): void => {
  const run = (): void => {
    const known = sessionKnown;
    if (generation !== pageGeneration || known === null) return;
    const fresh = findTranslationCandidates(document.body, MAX_CANDIDATES_PER_SCAN, known, sessionRuleSet);
    if (fresh.length === 0) return;
    const near: TranslationItem[] = [];
    const far: TranslationItem[] = [];
    let cached = 0;
    let skipped = 0;
    for (const candidate of fresh) {
      known.add(candidate.element);
      const { item, outcome } = acceptCandidate(candidate);
      if (outcome === 'cached') cached += 1;
      else if (outcome === 'skip') skipped += 1;
      if (item) (isNearViewport(item.element) ? near : far).push(item);
    }
    logger.info('content.page_rescan.discovered', {
      discovered: fresh.length,
      queued: near.length + far.length,
      cached,
      skipped,
      knownSize: known.size,
    });
    if (near.length > 0) enqueueItems(near, { front: true });
    if (far.length > 0) {
      if (controller) controller.observeMore(far);
      else enqueueItems(far); // 无 IntersectionObserver：与初始全量入队兜底保持一致
    }
  };
  let scrollTimer: number | undefined;
  const onScroll = (): void => {
    if (scrollTimer !== undefined) return;
    scrollTimer = window.setTimeout(() => {
      scrollTimer = undefined;
      run();
    }, RESCAN_THROTTLE_MS);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  rescanCleanup = (): void => {
    window.removeEventListener('scroll', onScroll);
    if (scrollTimer !== undefined) window.clearTimeout(scrollTimer);
    scrollTimer = undefined;
  };
};

/** 注入会话规则集（main 每次翻译前按 host 编译后调用）。 */
export const setSessionRuleSet = (ruleSet: CompiledRuleSet): void => {
  sessionRuleSet = ruleSet;
};

export const translatePage = async (maxBatchSize?: number): Promise<{ translated: number; skipped: number; deferred: number; cached?: number }> => {
  updatePageContext();
  const generation = ++pageGeneration;
  cancelInFlight();

  // 缓存会话：按当前目标语言读入整表；已缓存的段落直接渲染，不再请求模型
  const config = await getConfig();
  await startCacheSession(config.targetLanguage);
  sessionBackend = getProviderMeta(config.providerId).kind === 'mt' ? 'mt' : 'openai';

  const candidates = findTranslationCandidates(document.body, MAX_CANDIDATES_PER_SCAN, undefined, sessionRuleSet);
  logger.info('content.page_translation.start', { generation, candidates: candidates.length, url: location.href });
  // 会话已知集：滚动补扫时引擎据此跳过，只返回第 101+ 段的新候选
  sessionKnown = new Set<HTMLElement>(candidates.map((candidate) => candidate.element));

  translatedCount = 0;
  let skipped = 0;
  let cachedCount = 0;
  const queueable: TranslationItem[] = [];
  for (const candidate of candidates) {
    const { item, outcome } = acceptCandidate(candidate);
    if (outcome === 'skip') {
      skipped += 1;
      continue;
    }
    if (outcome === 'cached') {
      translatedCount += 1;
      cachedCount += 1;
      continue;
    }
    if (item) queueable.push(item);
  }

  const visible: TranslationItem[] = [];
  const offscreen: TranslationItem[] = [];
  for (const item of queueable) {
    if (isNearViewport(item.element)) visible.push(item);
    else offscreen.push(item);
  }

  const effectiveBatchSize = Math.max(1, Math.min(maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE, DEFAULT_MAX_BATCH_SIZE));
  const scheduler = new BatchingScheduler<TranslationItem>({
    batchSize: effectiveBatchSize,
    concurrency: CONCURRENCY,
    runBatch: (items) => runBatch(items, generation),
    ...(sessionBackend === 'openai'
      ? { itemChars: (item: TranslationItem) => item.text.length, maxBatchChars: MAX_BATCH_INPUT_CHARS }
      : {}),
  });
  activeScheduler = scheduler;

  /** 入队并登记序号/原文：上下文窗口按 enqueue 顺序取相邻段
   *  （初始扫描与补扫均按文档顺序入队；跳读抢占的插队项序号仍按到达时刻登记，属可接受近似）。 */
  const enqueueItems = (items: TranslationItem[], options?: { front?: boolean }): void => {
    for (const item of items) {
      item.seq = enqueueSeq;
      sessionTexts[enqueueSeq] = item.text;
      enqueueSeq += 1;
    }
    scheduler.enqueue(items, options);
  };

  let scrollEnqueued = 0;
  enqueueItems(visible);

  let controller: OffscreenController | null = null;
  if (offscreen.length > 0) {
    controller = observeOffscreen(
      offscreen,
      (batch) => {
        if (generation !== pageGeneration) return;
        scrollEnqueued += batch.length;
        // 近窗口 = 用户正在到达：插队压过仍在队中的预取积压
        enqueueItems(batch, { front: true });
      },
      (batch) => {
        if (generation !== pageGeneration) return;
        scrollEnqueued += batch.length;
        enqueueItems(batch);
      },
    );
  }
  activeOffscreen = controller;
  if (offscreen.length > 0 && controller === null) {
    // 无 IntersectionObserver：全量入队（既有兜底，等价于全文预翻译）
    enqueueItems(offscreen);
    scrollEnqueued = offscreen.length;
  }
  if (sessionKnown !== null && sessionKnown.size >= MAX_CANDIDATES_PER_SCAN) {
    // 首扫已达单次上限：文档可能还有第 101+ 段，挂滚动补扫
    startRescan(generation, enqueueItems, controller);
  }

  await scheduler.waitForIdle();
  flushCacheWrites();

  const deferred = Math.max(0, offscreen.length - scrollEnqueued);
  logger.info('content.page_translation.complete', { generation, translated: translatedCount, cached: cachedCount, skipped, deferred });
  return { translated: translatedCount, skipped, deferred, cached: cachedCount };
};
