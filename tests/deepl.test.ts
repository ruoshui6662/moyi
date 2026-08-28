import { describe, expect, it, vi } from 'vitest';
import { TranslationServiceError } from '../chrome-plugin/src/service/common';
import {
  deeplTargetLang,
  testDeeplConnection,
  translateWithDeepl,
} from '../chrome-plugin/src/service/deepl';

const baseRequest = {
  apiKey: 'deepl-key',
  endpoint: 'https://api-free.deepl.com/v2',
  targetLanguage: '简体中文',
};

describe('deeplTargetLang', () => {
  it('maps plugin languages to DeepL codes', () => {
    expect(deeplTargetLang('简体中文')).toBe('ZH');
    expect(deeplTargetLang('繁體中文')).toBe('ZH-HANT');
    expect(deeplTargetLang('English')).toBe('EN');
    expect(deeplTargetLang('日本語')).toBe('JA');
    expect(deeplTargetLang('한국어')).toBe('KO');
    expect(deeplTargetLang('未支持语言')).toBe('ZH');
  });
});

describe('translateWithDeepl', () => {
  it('translates multiple paragraphs in one request and returns them in order', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ translations: [{ text: '你好' }, { text: '世界' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await translateWithDeepl({ ...baseRequest, texts: ['Hello', 'World'] });
    expect(result).toEqual(['你好', '世界']);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api-free.deepl.com/v2/translate');
    expect(init.headers).toMatchObject({ Authorization: 'DeepL-Auth-Key deepl-key' });
    const body = JSON.parse(String(init.body));
    expect(body.text).toEqual(['Hello', 'World']);
    expect(body.target_lang).toBe('ZH');
  });

  it('returns empty array for blank texts without calling the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await translateWithDeepl({ ...baseRequest, texts: ['', '  '] });
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes non-2xx responses to a typed service error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: 'authentication failed' }),
      { status: 401 },
    )));

    await expect(translateWithDeepl({ ...baseRequest, texts: ['Hi'] }))
      .rejects.toMatchObject({ name: 'TranslationServiceError', status: 401 });
  });

  it('surfaces quota/rate errors with the raw detail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      'Quota exceeded',
      { status: 429 },
    )));

    await expect(translateWithDeepl({ ...baseRequest, texts: ['Hi'] }))
      .rejects.toThrow(/429|Quota/);
  });

  it('guards missing api key and endpoint', async () => {
    await expect(translateWithDeepl({ ...baseRequest, apiKey: '', texts: ['Hi'] }))
      .rejects.toBeInstanceOf(TranslationServiceError);
    await expect(translateWithDeepl({ ...baseRequest, endpoint: '', texts: ['Hi'] }))
      .rejects.toBeInstanceOf(TranslationServiceError);
  });
});

describe('testDeeplConnection', () => {
  it('pings with a minimal text and returns the translated word', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ translations: [{ text: '嗨' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(testDeeplConnection(baseRequest)).resolves.toBe('嗨');
  });
});