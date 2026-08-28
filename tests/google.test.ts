import { describe, expect, it, vi } from 'vitest';
import { TranslationServiceError } from '../chrome-plugin/src/service/common';
import type { MtTranslationRequest } from '../chrome-plugin/src/service/mt';
import {
  GOOGLE_TRANSLATE_API_KEY,
  GOOGLE_TRANSLATE_CLIENT,
  GOOGLE_TRANSLATE_ENDPOINT,
  googleAdapter,
  googleTargetLang,
  testGoogleConnection,
  translateWithGoogle,
} from '../chrome-plugin/src/service/google';

const baseReq: MtTranslationRequest = {
  apiKey: '',
  endpoint: GOOGLE_TRANSLATE_ENDPOINT,
  targetLanguage: '简体中文',
};

/** 构造 translateHtml 响应：result[0][0] 为译文 HTML 字符串。 */
const okResponse = (translatedHtml: string): Response =>
  new Response(JSON.stringify([[translatedHtml]]), { status: 200, headers: { 'Content-Type': 'application/json+protobuf' } });

describe('googleTargetLang', () => {
  it('maps plugin languages to Google codes', () => {
    expect(googleTargetLang('简体中文')).toBe('zh-CN');
    expect(googleTargetLang('繁體中文')).toBe('zh-TW');
    expect(googleTargetLang('English')).toBe('en');
    expect(googleTargetLang('日本語')).toBe('ja');
    expect(googleTargetLang('한국어')).toBe('ko');
    expect(googleTargetLang('未支持语言')).toBe('zh-CN');
  });
});

describe('translateWithGoogle', () => {
  it('posts a signed translateHtml request with the workspace key and parses result[0][0]', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(okResponse('你好')));
    vi.stubGlobal('fetch', fetchMock);

    const result = await translateWithGoogle(['Hello'], baseReq);
    expect(result).toEqual(['你好']);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GOOGLE_TRANSLATE_ENDPOINT);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Goog-API-Key']).toBe(GOOGLE_TRANSLATE_API_KEY);
    expect(headers['Content-Type']).toBe('application/json+protobuf');
    const body = JSON.parse(String(init.body));
    // body = [[[escapedText], fromLang, toLang], "wt_lib"]；from=auto、to=zh-CN
    expect(body).toEqual([[['Hello'], 'auto', 'zh-CN'], GOOGLE_TRANSLATE_CLIENT]);
  });

  it('escapes and unescapes HTML so the HTML-parsing endpoint cannot corrupt text', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(okResponse('a &lt; b &amp; c')));
    vi.stubGlobal('fetch', fetchMock);

    const result = await translateWithGoogle(['a < b & c'], baseReq);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as [[[string], string, string], string];
    expect(body[0][0][0]).toBe('a &lt; b &amp; c'); // 发送前转义
    expect(result).toEqual(['a < b & c']); // 接收后解码一次
  });

  it('keeps the 1:1 contract and skips empty texts in the payload', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(okResponse('世界')));
    vi.stubGlobal('fetch', fetchMock);
    const result = await translateWithGoogle(['Hi', '', 'World'], baseReq);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 空文本不进请求
    expect(result).toEqual(['世界', '', '世界']);
  });

  it('splits overlong paragraphs and rejoins them per paragraph', async () => {
    const longText = '汉'.repeat(1800); // 5400 字节 > 5000 上限 → 2 块
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(okResponse('块一')))
      .mockImplementationOnce(() => Promise.resolve(okResponse('块二')))
      .mockImplementationOnce(() => Promise.resolve(okResponse('短')));
    vi.stubGlobal('fetch', fetchMock);
    const result = await translateWithGoogle([longText, 'short'], baseReq);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result[0]).toBe('块一\n块二');
    expect(result[1]).toBe('短');
  });

  it('returns [] without calling the API for empty input', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(translateWithGoogle([], baseReq)).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes non-2xx responses into a typed service error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response('forbidden', { status: 403 }))));
    await expect(translateWithGoogle(['hi'], baseReq)).rejects.toBeInstanceOf(TranslationServiceError);
    await expect(translateWithGoogle(['hi'], baseReq)).rejects.toThrow(/403/);
  });

  it('guards a missing endpoint', async () => {
    await expect(translateWithGoogle(['hi'], { ...baseReq, endpoint: '' }))
      .rejects.toBeInstanceOf(TranslationServiceError);
  });
});

describe('testGoogleConnection', () => {
  it('translates a minimal probe text and returns it', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(okResponse('嗨')));
    vi.stubGlobal('fetch', fetchMock);
    await expect(testGoogleConnection(baseReq)).resolves.toBe('嗨');
  });
});

describe('googleAdapter', () => {
  it('implements the MT adapter contract without credentials', () => {
    expect(googleAdapter.id).toBe('google');
    expect(googleAdapter.translateBatch).toBe(translateWithGoogle);
    expect(googleAdapter.testConnection).toBe(testGoogleConnection);
  });
});