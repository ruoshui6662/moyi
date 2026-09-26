import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 翻译编排层（trans.ts）集成测试——补 README 待办 10 的盲区。
 *
 * 为什么这层必须有测试：近三轮真机反馈的 bug（触发时序、选段上限、动态批上限、
 * 跨批上下文）全部发生在这一层，而它此前零单测。这里用「mock 边界 + 真实 DOM +
 * 真实调度器/引擎」的方式把主流程钉住：
 * - 候选发现（translation-core 真实，站点规则真实生效）
 * - 批编排（BatchingScheduler 真实，mock 掉网络出口）
 * - 渲染与还原（translationRenderer 真实落 DOM）
 * - 缓存读写（translationCache mock 为内存表，保留 cacheKey 真实语义）
 */

const cacheTable = new Map<string, { t: string; at: number }>();
const streamCalls: { paragraphs: string[]; maxBatchSize?: number; pageContext?: string; precedingParagraphs?: string[] }[] = [];
const batchCalls: { paragraphs: string[]; maxBatchSize?: number; precedingParagraphs?: string[] }[] = [];
const singleCalls: { text: string; preceding?: string[] }[] = [];
let backendKind: 'openai' | 'mt' = 'openai';
let streamReply = (paragraphs: string[]): Record<number, string> =>
  Object.fromEntries(paragraphs.map((_, i) => [i, '译文' + i]));
/** 非空时流式通道回放 onError（真实链路的失败形态）。 */
let streamError = '';

vi.mock('../chrome-plugin/src/utils/translateApi', () => ({
  extractPageContext: () => 'Page context - Title: 测试页',
  requestTranslation: vi.fn(async (text: string, precedingParagraphs?: string[]) => {
    singleCalls.push({ text, preceding: precedingParagraphs });
    return '单段译文';
  }),
  requestBatchTranslation: vi.fn(async (paragraphs: string[], maxBatchSize?: number, _pageContext?: string, precedingParagraphs?: string[]) => {
    batchCalls.push({ paragraphs, maxBatchSize, precedingParagraphs });
    return paragraphs.map((_, i) => 'MT' + i);
  }),
  streamBatchTranslation: vi.fn((paragraphs: string[], callbacks: {
    maxBatchSize?: number; pageContext?: string; precedingParagraphs?: string[];
    onPartial: (index: number, text: string) => void; onParagraph: (index: number, text: string) => void;
    onError: (error: string) => void; onDone: (completed: number, truncated?: boolean) => void;
  }) => {
    streamCalls.push({ paragraphs, maxBatchSize: callbacks.maxBatchSize, pageContext: callbacks.pageContext, precedingParagraphs: callbacks.precedingParagraphs });
    if (streamError) {
      callbacks.onError(streamError);
      return { abort: () => undefined };
    }
    const reply = streamReply(paragraphs);
    // 同步回放：真实链路是异步分片，这里保持「立即完成」以免测试等待
    for (let i = 0; i < paragraphs.length; i += 1) {
      callbacks.onPartial(i, reply[i]);
      callbacks.onParagraph(i, reply[i]);
    }
    callbacks.onDone(paragraphs.length, false);
    return { abort: () => undefined };
  }),
}));

vi.mock('../chrome-plugin/src/utils/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chrome-plugin/src/utils/config')>();
  return { ...actual, getConfig: vi.fn(async () => ({ ...actual.DEFAULT_CONFIG, providerId: backendKind === 'mt' ? 'deepl' : 'openai' })) };
});

vi.mock('../chrome-plugin/src/entrypoints/content/translationCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chrome-plugin/src/entrypoints/content/translationCache')>();
  return {
    ...actual,
    loadTranslationCache: vi.fn(async () => Object.fromEntries(cacheTable)),
    saveTranslationCache: vi.fn(async (table: Record<string, { t: string; at: number }>, pairs: { language: string; text: string; translation: string }[]) => {
      for (const pair of pairs) table[actual.cacheKey(pair.language, pair.text)] = { t: pair.translation, at: Date.now() };
    }),
  };
});

vi.mock('../chrome-plugin/src/utils/logger', () => ({
  logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
}));

import {
  DEFAULT_MAX_BATCH_SIZE,
  restoreAllTranslations,
  setSessionRuleSet,
  translatePage,
} from '../chrome-plugin/src/entrypoints/content/trans';
import { compileRuleSet, sanitizeSiteRules } from '../chrome-plugin/src/utils/siteRules';
import { cacheKey } from '../chrome-plugin/src/entrypoints/content/translationCache';

const page = (html: string): void => {
  document.body.innerHTML = html;
  document.title = '测试页';
};

const paragraphs = (count: number): string =>
  Array.from({ length: count }, (_, i) => `<p>Paragraph number ${i} with enough readable words to be meaningful.</p>`).join('');

const ownedNodes = (): NodeListOf<HTMLElement> =>
  document.querySelectorAll<HTMLElement>('[data-personal-translator-owned]');

beforeEach(() => {
  cacheTable.clear();
  streamCalls.length = 0;
  batchCalls.length = 0;
  singleCalls.length = 0;
  backendKind = 'openai';
  streamReply = (ps) => Object.fromEntries(ps.map((_, i) => [i, '译文' + i]));
  streamError = '';
  setSessionRuleSet({ include: [], exclude: [], forceInclude: false });
  restoreAllTranslations();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('translatePage 编排主流程', () => {
  it('openai 路径：流式请求按上限装箱并把译文落进 DOM', async () => {
    page(paragraphs(3));
    const result = await translatePage();
    expect(result.translated).toBe(3);
    expect(ownedNodes()).toHaveLength(3);
    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0]?.paragraphs).toHaveLength(3);
    expect(streamCalls[0]?.maxBatchSize).toBe(DEFAULT_MAX_BATCH_SIZE);
    expect(streamCalls[0]?.pageContext).toContain('测试页');
  });

  it('长文按 16 段装箱（100 段 → 7 批），每批带上文窗口', async () => {
    page(paragraphs(100));
    await translatePage();
    const sizes = streamCalls.map((call) => call.paragraphs.length);
    expect(sizes).toEqual([16, 16, 16, 16, 16, 16, 4]);
    // 第二批起带上前批末尾 3 段；首批无上文
    expect(streamCalls[0]?.precedingParagraphs ?? []).toHaveLength(0);
    expect(streamCalls[1]?.precedingParagraphs).toHaveLength(3);
    expect(streamCalls[1]?.precedingParagraphs?.[2]).toBe('Paragraph number 15 with enough readable words to be meaningful.');
    expect(ownedNodes()).toHaveLength(100);
  });

  it('缓存命中直接渲染不发请求（命中段落不计入请求批次）', async () => {
    page(paragraphs(3));
    cacheTable.set(cacheKey('简体中文', 'Paragraph number 1 with enough readable words to be meaningful.'), { t: '缓存译文', at: Date.now() });
    const result = await translatePage();
    expect(result.cached).toBe(1);
    expect(streamCalls[0]?.paragraphs).toHaveLength(2);
    expect(document.body.textContent).toContain('缓存译文');
  });

  it('MT 路径：整批直译一次，且不吃上文窗口（无提示词）', async () => {
    backendKind = 'mt';
    page(paragraphs(3));
    const result = await translatePage();
    expect(result.translated).toBe(3);
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]?.paragraphs).toHaveLength(3);
    expect(streamCalls).toHaveLength(0);
  });

  it('还原：移除译文节点、恢复原文，重复翻译仍可再来一轮', async () => {
    page(paragraphs(2));
    await translatePage();
    expect(ownedNodes()).toHaveLength(2);
    restoreAllTranslations();
    expect(ownedNodes()).toHaveLength(0);
    expect(document.body.textContent).toContain('Paragraph number 0');
    await translatePage();
    expect(ownedNodes()).toHaveLength(2);
  });

  it('站点规则端到端：forceInclude 捞回被剪枝器漏掉的 .notranslate 正文', async () => {
    page(`
      <article><p>Visible article paragraph with readable words.</p></article>
      <div class="notranslate"><p>Missed article body that the pruner discarded entirely.</p></div>`);
    const rules = sanitizeSiteRules([{
      name: '正文强捞', hostPattern: 'example.com', includeSelectors: ['.notranslate p'], excludeSelectors: [], forceInclude: true, enabled: true, source: 'personal', id: 'r1',
    }]);
    setSessionRuleSet(compileRuleSet(rules, 'example.com'));
    const result = await translatePage();
    const sent = streamCalls.flatMap((call) => call.paragraphs).join(' ');
    expect(sent).toContain('Missed article body');
    expect(result.translated).toBe(2);
  });

  it('翻译失败：段落渲染错误态而非静默留白，且不产生缓存', async () => {
    streamError = 'boom';
    page(paragraphs(2)); // ≥2 段才走流式通道（单段走 requestTranslation 独立分支）
    const result = await translatePage();
    expect(result.translated).toBe(0);
    expect(document.body.textContent).toContain('boom');
    expect(cacheTable.size).toBe(0);
  });
});
