import { describe, expect, it, vi } from 'vitest';
import { TranslationServiceError } from '../chrome-plugin/src/service/common';
import type { MtTranslationRequest } from '../chrome-plugin/src/service/mt';
import {
  microsoftAdapter,
  microsoftTargetLang,
  testMicrosoftConnection,
  translateWithMicrosoft,
} from '../chrome-plugin/src/service/microsoft';

const baseReq: MtTranslationRequest = {
  apiKey: '',
  endpoint: 'https://edge.microsoft.com/translate/translatetext',
  targetLanguage: '简体中文',
};

const okResponse = (items: { translations: { text: string }[] }[]): Response =>
  new Response(JSON.stringify(items), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('microsoftTargetLang', () => {
  it('maps plugin languages to Edge translator codes', () => {
    expect(microsoftTargetLang('简体中文')).toBe('zh');
    expect(microsoftTargetLang('繁體中文')).toBe('zh-TW');
    expect(microsoftTargetLang('English')).toBe('en');
    expect(microsoftTargetLang('日本語')).toBe('ja');
    expect(microsoftTargetLang('한국어')).toBe('ko');
    expect(microsoftTargetLang('未支持语言')).toBe('zh');
  });
});

describe('translateWithMicrosoft', () => {
  it('posts a bare string array to the unauthenticated endpoint and returns in order', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      okResponse([{ translations: [{ text: '你好' }] }, { translations: [{ text: '世界' }] }]),
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await translateWithMicrosoft(['Hello', 'World'], baseReq);
    expect(result).toEqual(['你好', '世界']);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://edge.microsoft.com/translate/translatetext?from=&to=zh&isEnterpriseClient=false');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(String(init.body))).toEqual(['Hello', 'World']);
  });

  it('auto-detects source language via empty from param', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      okResponse([{ translations: [{ text: '你好' }] }]),
    ));
    vi.stubGlobal('fetch', fetchMock);
    await translateWithMicrosoft(['hello'], { ...baseReq, targetLanguage: 'English' });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('from=&to=en&isEnterpriseClient=false');
  });

  it('escapes and unescapes angle brackets so the HTML tag aligner cannot corrupt text', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      okResponse([{ translations: [{ text: 'a &lt; b &amp; c' }] }]),
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await translateWithMicrosoft(['a < b & c'], baseReq);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as string[];
    expect(body[0]).toBe('a &lt; b &amp; c'); // 发送前转义
    expect(result).toEqual(['a < b & c']); // 接收后解码一次
  });

  it('keeps the 1:1 contract and skips empty texts in the payload', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      okResponse([{ translations: [{ text: '你好' }] }, { translations: [{ text: '世界' }] }]),
    ));
    vi.stubGlobal('fetch', fetchMock);
    const result = await translateWithMicrosoft(['Hi', '', 'World'], baseReq);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as string[];
    expect(body).toEqual(['Hi', 'World']);
    expect(result).toEqual(['你好', '', '世界']);
  });

  it('splits overlong paragraphs and rejoins them per paragraph', async () => {
    const longText = '汉'.repeat(1800); // 5400 字节 > 5000 上限 → 2 块
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      okResponse([{ translations: [{ text: '块一' }] }, { translations: [{ text: '块二' }] }, { translations: [{ text: '短' }] }]),
    ));
    vi.stubGlobal('fetch', fetchMock);
    const result = await translateWithMicrosoft([longText, 'short'], baseReq);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as string[];
    expect(body.length).toBe(3);
    expect(result[0]).toBe('块一\n块二');
    expect(result[1]).toBe('短');
  });

  it('returns [] without calling the API for empty input', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(translateWithMicrosoft([], baseReq)).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes non-2xx responses into a typed service error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(
      new Response('rate limited', { status: 429 }),
    )));
    await expect(translateWithMicrosoft(['hi'], baseReq)).rejects.toBeInstanceOf(TranslationServiceError);
    await expect(translateWithMicrosoft(['hi'], baseReq)).rejects.toThrow(/429/);
  });

  it('guards a missing endpoint', async () => {
    await expect(translateWithMicrosoft(['hi'], { ...baseReq, endpoint: '' }))
      .rejects.toBeInstanceOf(TranslationServiceError);
  });
});

describe('testMicrosoftConnection', () => {
  it('translates a minimal probe text and returns it', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      okResponse([{ translations: [{ text: '嗨' }] }]),
    ));
    vi.stubGlobal('fetch', fetchMock);
    await expect(testMicrosoftConnection(baseReq)).resolves.toBe('嗨');
  });
});

describe('microsoftAdapter', () => {
  it('implements the MT adapter contract without credentials', () => {
    expect(microsoftAdapter.id).toBe('microsoft');
    expect(microsoftAdapter.translateBatch).toBe(translateWithMicrosoft);
    expect(microsoftAdapter.testConnection).toBe(testMicrosoftConnection);
  });
});