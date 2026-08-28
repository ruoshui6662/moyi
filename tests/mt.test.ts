import { describe, expect, it, vi } from 'vitest';
import {
  getMtAdapter,
  rejoinChunkTranslations,
  splitByUtf8Bytes,
  splitOverlongParagraphs,
} from '../chrome-plugin/src/service/mt';
import { deeplAdapter } from '../chrome-plugin/src/service/deepl';
import { tencentAdapter } from '../chrome-plugin/src/service/tencent';
import { microsoftAdapter } from '../chrome-plugin/src/service/microsoft';
import { googleAdapter } from '../chrome-plugin/src/service/google';

describe('splitByUtf8Bytes', () => {
  it('returns the text unchanged when it fits', () => {
    expect(splitByUtf8Bytes('hello', 10)).toEqual(['hello']);
  });

  it('never splits a multi-byte character across chunks', () => {
    const text = '汉'.repeat(10); // 30 字节
    const chunks = splitByUtf8Bytes(text, 5); // 5 字节 = 1 个汉字 + 2 字节余量
    expect(chunks.join('')).toBe(text);
    for (const chunk of chunks) {
      expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(6);
    }
  });

  it('splits at byte boundaries for ascii text', () => {
    expect(splitByUtf8Bytes('abcdefgh', 3)).toEqual(['abc', 'def', 'gh']);
  });
});

describe('splitOverlongParagraphs / rejoinChunkTranslations', () => {
  it('splits only overlong paragraphs and keeps chunk-to-item mapping', () => {
    const longText = '汉'.repeat(700); // 2100 字节
    const { chunks, itemOfChunk } = splitOverlongParagraphs(['short', longText, ''], 1800);
    expect(chunks).toHaveLength(3); // short + 长段 2 块；空文本不产生块
    expect(itemOfChunk).toEqual([0, 1, 1]);
  });

  it('rejoins chunk translations back into 1:1 paragraph results', () => {
    const { chunks, itemOfChunk } = splitOverlongParagraphs(['short', '汉'.repeat(700)], 1800);
    const translations = rejoinChunkTranslations(['S', '块1', '块2'], itemOfChunk, 2);
    expect(translations).toEqual(['S', '块1\n块2']);
  });

  it('is a no-op for within-limit inputs', () => {
    const { chunks, itemOfChunk } = splitOverlongParagraphs(['a', 'b'], 1000);
    expect(chunks).toEqual(['a', 'b']);
    expect(itemOfChunk).toEqual([0, 1]);
    expect(rejoinChunkTranslations(['A', 'B'], itemOfChunk, 2)).toEqual(['A', 'B']);
  });
});

describe('MT adapter registry', () => {
  it('resolves deepl, tencent, microsoft and google adapters', () => {
    expect(getMtAdapter('deepl').id).toBe('deepl');
    expect(getMtAdapter('tencent').id).toBe('tencent');
    expect(getMtAdapter('microsoft').id).toBe('microsoft');
    expect(getMtAdapter('google').id).toBe('google');
  });

  it('rejects unknown backend ids', () => {
    expect(() => getMtAdapter('nope')).toThrow('未知的翻译服务');
  });

  it('all adapters satisfy the MtAdapter contract shape', () => {
    for (const adapter of [deeplAdapter, tencentAdapter, microsoftAdapter, googleAdapter]) {
      expect(typeof adapter.translateBatch).toBe('function');
      expect(typeof adapter.testConnection).toBe('function');
      expect(adapter.maxBatchSize).toBeGreaterThan(0);
      expect(adapter.maxItemBytes).toBeGreaterThan(0);
    }
  });
});

describe('deeplAdapter 1:1 contract', () => {
  it('pads empty inputs to keep index alignment with the original list', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ translations: [{ text: '你好' }, { text: '世界' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await deeplAdapter.translateBatch(
      ['Hello', '', 'World'],
      { apiKey: 'k', endpoint: 'https://api-free.deepl.com/v2', targetLanguage: '简体中文' },
    );
    expect(result).toEqual(['你好', '', '世界']);
  });

  it('returns all empty strings without calling the API for an all-empty batch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await deeplAdapter.translateBatch(
      ['', '  '],
      { apiKey: 'k', endpoint: 'https://api-free.deepl.com/v2', targetLanguage: '简体中文' },
    );
    expect(result).toEqual(['', '']);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});