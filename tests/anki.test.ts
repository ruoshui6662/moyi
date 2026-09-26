import { describe, expect, it, vi } from 'vitest';
import {
  ANKI_DECK,
  ANKI_MODEL,
  buildAddNotesAction,
  buildAnkiFields,
  callAnki,
  exportVocabToAnki,
} from '../chrome-plugin/src/utils/anki';
import type { VocabEntry } from '../chrome-plugin/src/utils/vocabbook';

const entry = (over: Partial<VocabEntry> = {}): VocabEntry => ({
  word: 'ephemeral',
  translation: '短暂的',
  context: 'Ephemeral joys fade fast.',
  pageTitle: '阅读',
  url: 'https://e.com/a',
  createdAt: 1_700_000_000_000,
  ...over,
});

/** 假 AnkiConnect：按 action 记录调用并返回脚本化结果。 */
const fakeAnki = (responses: Record<string, unknown> = {}) => {
  const calls: { action: string; params?: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { action: string; params?: Record<string, unknown> };
    calls.push(body);
    const result = responses[body.action] ?? (body.action === 'modelNames' || body.action === 'deckNames' ? [ANKI_MODEL, ANKI_DECK] : [1, 2]);
    return new Response(JSON.stringify({ result, error: null }), { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
};

describe('Anki 请求构造', () => {
  it('字段映射含单词/译名/上下文/出处（出处=标题·URL）', () => {
    const fields = buildAnkiFields(entry());
    expect(fields['单词']).toBe('ephemeral');
    expect(fields['译名']).toBe('短暂的');
    expect(fields['出处']).toBe('阅读 · https://e.com/a');
  });

  it('字段限长（防超长上下文撑坏笔记）', () => {
    const fields = buildAnkiFields(entry({ context: 'x'.repeat(2000), pageTitle: 't'.repeat(400) }));
    expect(fields['上下文']).toHaveLength(1000);
    expect(fields['出处'].length).toBeLessThanOrEqual(500);
  });

  it('addNotes：牌组/类型/标签/允许重复，字段空串占位', () => {
    const action = buildAddNotesAction([entry(), entry({ word: 'x', translation: '' })]);
    expect(action.action).toBe('addNotes');
    const notes = (action.params?.notes as { deckName: string; modelName: string; tags: string[]; options: { allowDuplicate: boolean }; fields: Record<string, string> }[]);
    expect(notes).toHaveLength(2);
    expect(notes[0]?.deckName).toBe(ANKI_DECK);
    expect(notes[0]?.modelName).toBe(ANKI_MODEL);
    expect(notes[0]?.tags).toContain('墨译');
    expect(notes[0]?.options.allowDuplicate).toBe(true);
    expect(notes[1]?.fields['译名']).toBe('（空）');
  });
});

describe('callAnki 错误映射', () => {
  it('协议 error → 原样抛出', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ result: null, error: 'model was not found' }), { status: 200 })) as unknown as typeof fetch;
    await expect(callAnki({ action: 'addNotes' }, { fetchImpl })).rejects.toThrow(/model was not found/);
  });

  it('连不上（TypeError）→ 安装引导文案', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    await expect(callAnki({ action: 'version' }, { fetchImpl })).rejects.toThrow(/AnkiConnect 插件/);
  });

  it('HTTP 非 2xx → 状态码文案', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    await expect(callAnki({ action: 'version' }, { fetchImpl })).rejects.toThrow(/HTTP 503/);
  });
});

describe('exportVocabToAnki 流程（假 AnkiConnect）', () => {
  it('模型与牌组都存在时：只 addNotes', async () => {
    const { fetchImpl, calls } = fakeAnki({ modelNames: [ANKI_MODEL], deckNames: [ANKI_DECK], addNotes: [11, 12, null] });
    const result = await exportVocabToAnki([entry(), entry({ word: 'b' }), entry({ word: 'c' })], { fetchImpl });
    expect(calls.map((c) => c.action)).toEqual(['modelNames', 'deckNames', 'addNotes']);
    expect(result).toEqual({ added: 2, modelCreated: false, deckCreated: false });
  });

  it('模型/牌组缺失时自动创建（先查再建）', async () => {
    const { fetchImpl, calls } = fakeAnki({ modelNames: [], deckNames: [], addNotes: [1] });
    const result = await exportVocabToAnki([entry()], { fetchImpl });
    expect(calls.map((c) => c.action)).toEqual(['modelNames', 'createModel', 'deckNames', 'createDeck', 'addNotes']);
    expect(result.modelCreated).toBe(true);
    expect(result.deckCreated).toBe(true);
  });

  it('空生词本直接拒绝（不建连）', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(exportVocabToAnki([], { fetchImpl })).rejects.toThrow(/生词本为空/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
