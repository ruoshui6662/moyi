import { describe, expect, it } from 'vitest';
import {
  VOCABBOOK_MAX_ENTRIES,
  formatVocabDate,
  sanitizeVocabEntries,
  toVocabCsv,
  toVocabJson,
  upsertVocabEntry,
  vocabPageKey,
} from '../chrome-plugin/src/utils/vocabbook';

const makeEntry = (overrides: Partial<Parameters<typeof upsertVocabEntry>[1]> = {}): Parameters<typeof upsertVocabEntry>[1] => ({
  word: 'ephemeral',
  translation: '短暂的',
  context: 'Ephemeral joys fade fast.',
  pageTitle: 'Reading page',
  url: 'https://example.com/articles/1',
  createdAt: 1_700_000_000_000,
  ...overrides,
});

describe('vocabPageKey', () => {
  it('strips query and hash: page identity, not session state', () => {
    expect(vocabPageKey('https://example.com/a?x=1#top')).toBe('https://example.com/a');
    expect(vocabPageKey('https://example.com/a')).toBe('https://example.com/a');
  });

  it('falls back to raw text for non-URLs', () => {
    expect(vocabPageKey('not-a-url')).toBe('not-a-url');
  });
});

describe('sanitizeVocabEntries', () => {
  it('drops invalid shapes and empty words, caps field lengths', () => {
    const entries = sanitizeVocabEntries([
      null,
      42,
      { word: '', translation: 'x' },
      { word: `w${'o'.repeat(200)}`, translation: 't', url: 'https://e.com/p', createdAt: 5 },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.word).toHaveLength(80);
  });

  it('dedupes case-insensitively per page keeping the newest', () => {
    const entries = sanitizeVocabEntries([
      makeEntry({ word: 'Kubernetes', translation: '旧', createdAt: 1 }),
      makeEntry({ word: 'kubernetes', translation: '新', createdAt: 2 }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.translation).toBe('新');
  });

  it('keeps the same word on different pages as separate entries', () => {
    const entries = sanitizeVocabEntries([
      makeEntry({ url: 'https://a.com/x', createdAt: 1 }),
      makeEntry({ url: 'https://b.com/y', createdAt: 2 }),
    ]);
    expect(entries).toHaveLength(2);
  });

  it('caps total entries keeping the newest', () => {
    const many = Array.from({ length: VOCABBOOK_MAX_ENTRIES + 50 }, (_, i) => makeEntry({ word: `w${i}`, createdAt: i }));
    const capped = sanitizeVocabEntries(many);
    expect(capped).toHaveLength(VOCABBOOK_MAX_ENTRIES);
    expect(capped[0]?.word).toBe('w50');
    expect(capped[capped.length - 1]?.word).toBe(`w${VOCABBOOK_MAX_ENTRIES + 49}`);
  });
});

describe('upsertVocabEntry', () => {
  it('overwrites same word on the same page', () => {
    const first = upsertVocabEntry([], makeEntry({ createdAt: 1 }));
    const second = upsertVocabEntry(first.entries, makeEntry({ translation: '更新译名', createdAt: 2 }));
    expect(second.updated).toBe(true);
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]?.translation).toBe('更新译名');
  });

  it('appends the same word from another page, case-insensitively', () => {
    const first = upsertVocabEntry([], makeEntry({ url: 'https://a.com/x' }));
    const second = upsertVocabEntry(first.entries, makeEntry({ word: 'EPHEMERAL', url: 'https://b.com/y' }));
    expect(second.updated).toBe(false);
    expect(second.entries).toHaveLength(2);
  });

  it('drops the oldest entry when over capacity', () => {
    const full = [
      makeEntry({ word: 'oldest', createdAt: 0 }),
      ...Array.from({ length: VOCABBOOK_MAX_ENTRIES }, (_, i) => makeEntry({ word: `w${i}`, createdAt: i + 1 })),
    ];
    const { entries } = upsertVocabEntry(full, makeEntry({ word: 'brand-new', createdAt: 999_999_999 }));
    expect(entries).toHaveLength(VOCABBOOK_MAX_ENTRIES);
    expect(entries.some((entry) => entry.word === 'oldest')).toBe(false);
    expect(entries[entries.length - 1]?.word).toBe('brand-new');
  });
});

describe('exports', () => {
  it('CSV starts with BOM, has Chinese header, CRLF endings, and escapes separators', () => {
    const csv = toVocabCsv([
      makeEntry({ word: 'a,b', context: 'line1\nline2 "quoted"', translation: '译名' }),
    ]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('单词,译名,上下文,页面标题,网址,收藏时间');
    expect(csv).toContain('"a,b"');
    expect(csv).toContain('"line1\nline2 ""quoted"""');
    expect(csv).toContain('\r\n');
  });

  it('date column is human-readable local time', () => {
    const csv = toVocabCsv([makeEntry({ createdAt: new Date(2026, 8, 24, 9, 5, 3).getTime() })]);
    expect(csv).toContain('2026-09-24 09:05:03');
  });

  it('formatVocabDate pads fields and tolerates invalid input', () => {
    expect(formatVocabDate(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe('2026-01-02 03:04:05');
    expect(formatVocabDate(Number.NaN)).toBe('');
  });

  it('JSON export round-trips through sanitize', () => {
    const entries = sanitizeVocabEntries([makeEntry()]);
    const parsed = sanitizeVocabEntries(JSON.parse(toVocabJson(entries)));
    expect(parsed).toEqual(entries);
  });
});
