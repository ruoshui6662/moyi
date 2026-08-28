import { describe, expect, it, vi } from 'vitest';
import { TranslationServiceError } from '../chrome-plugin/src/service/common';
import type { MtTranslationRequest } from '../chrome-plugin/src/service/mt';
import {
  buildTc3Signing,
  bytesToHex,
  hmacSha256,
  mapTencentError,
  sha256Bytes,
  tencentAdapter,
  tencentTargetLang,
  testTencentConnection,
  translateWithTencent,
} from '../chrome-plugin/src/service/tencent';

const baseReq: MtTranslationRequest = {
  apiKey: 'AKIDsid',
  apiSecret: 'skey-value',
  endpoint: 'https://tmt.tencentcloudapi.com',
  targetLanguage: '简体中文',
};

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('sha256 / hmac (零依赖同步实现，已知向量校验)', () => {
  it('matches NIST vectors for SHA-256', () => {
    expect(bytesToHex(sha256Bytes(utf8('')))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(bytesToHex(sha256Bytes(utf8('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    // 长输入（跨多个 64 字节块，验证 padding 与消息调度）
    expect(bytesToHex(sha256Bytes(utf8('a'.repeat(1000))))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
  });

  it('matches RFC 4231 HMAC-SHA-256 vector', () => {
    const key = new Uint8Array(20).fill(0x0b);
    const digest = hmacSha256(key, utf8('Hi There'));
    expect(bytesToHex(digest)).toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  });

  it('matches the classic key/message HMAC-SHA-256 vector', () => {
    expect(bytesToHex(hmacSha256(utf8('key'), utf8('The quick brown fox jumps over the lazy dog'))))
      .toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  });

  it('hashes keys longer than one block via the pre-hash path', () => {
    const longKey = utf8('k'.repeat(200));
    const digest = hmacSha256(longKey, utf8('data'));
    expect(bytesToHex(digest)).toHaveLength(64);
    expect(digest).not.toEqual(new Uint8Array(32));
  });
});

describe('tencentTargetLang', () => {
  it('maps plugin languages to Tencent codes with zh-TW for traditional', () => {
    expect(tencentTargetLang('简体中文')).toBe('zh');
    expect(tencentTargetLang('繁體中文')).toBe('zh-TW');
    expect(tencentTargetLang('English')).toBe('en');
    expect(tencentTargetLang('日本語')).toBe('ja');
    expect(tencentTargetLang('한국어')).toBe('ko');
    expect(tencentTargetLang('未支持语言')).toBe('zh');
  });
});

describe('buildTc3Signing', () => {
  it('produces a deterministic TC3 authorization header', () => {
    const result = buildTc3Signing({
      secretId: 'AKIDEXAMPLE',
      secretKey: 'secret-key',
      host: 'tmt.tencentcloudapi.com',
      region: 'ap-guangzhou',
      action: 'TextTranslate',
      payload: '{"SourceText":"hi"}',
      timestamp: 1551113065,
    });
    expect(result.date).toBe('2019-02-25');
    expect(result.authorization).toContain('TC3-HMAC-SHA256 Credential=AKIDEXAMPLE/2019-02-25/tmt/tc3_request');
    expect(result.authorization).toContain('SignedHeaders=content-type;host');
    expect(result.authorization).toMatch(/Signature=[0-9a-f]{64}$/);
  });

  it('changes signature when payload or secret changes (防篡改)', () => {
    const make = (payload: string, secretKey = 'sk'): string =>
      buildTc3Signing({
        secretId: 'AKIDa',
        secretKey,
        host: 'tmt.tencentcloudapi.com',
        region: 'ap-guangzhou',
        action: 'TextTranslate',
        payload,
        timestamp: 1551113065,
      }).authorization;
    const first = make('{"a":1}');
    const second = make('{"a":2}');
    const third = make('{"a":1}', 'other');
    expect(first).not.toBe(second);
    expect(first).not.toBe(third);
  });
});

describe('mapTencentError', () => {
  it('renders actionable messages per error family', () => {
    expect(mapTencentError('AuthFailure.SignatureFailure', 'sig bad').message).toMatch(/鉴权失败/);
    expect(mapTencentError('AuthFailure.SignatureFailure', 'sig bad').message).toMatch(/SecretId/);
    expect(mapTencentError('RequestLimitExceeded', 'freq').message).toMatch(/过于频繁/);
    expect(mapTencentError('FailedOperation.TranslationError', 'boom').message).toMatch(/请求被拒绝/);
    expect(mapTencentError('Weird.Code', 'x').message).toMatch(/服务错误/);
  });
});

describe('translateWithTencent', () => {
  it('sends a signed TextTranslateBatch request and returns translations in order', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ Response: { TargetTextList: ['你好', '世界'] } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await translateWithTencent(['Hello', 'World'], baseReq);
    expect(result).toEqual(['你好', '世界']);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://tmt.tencentcloudapi.com');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-TC-Action']).toBe('TextTranslateBatch');
    expect(headers['X-TC-Version']).toBe('2018-03-21');
    expect(headers['X-TC-Region']).toBe('ap-guangzhou');
    expect(headers.Authorization).toContain('TC3-HMAC-SHA256 Credential=AKIDsid/');
    expect(headers.Authorization).toContain('SignedHeaders=content-type;host');
    const body = JSON.parse(String(init.body)) as { SourceTextList: string[]; Source: string; Target: string; ProjectId: number };
    expect(body.SourceTextList).toEqual(['Hello', 'World']);
    expect(body.Source).toBe('auto');
    expect(body.Target).toBe('zh');
    expect(body.ProjectId).toBe(0);
  });

  it('defaults region to ap-guangzhou when omitted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ Response: { TargetTextList: ['嗨'] } }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);
    await translateWithTencent(['hi'], { ...baseReq, region: '' });
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['X-TC-Region']).toBe('ap-guangzhou');
  });

  it('splits overlong paragraphs into safe chunks and rejoins them per paragraph', async () => {
    const longText = '汉'.repeat(700); // 2100 字节 > 1800 安全阈值 → 2 块
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ Response: { TargetTextList: ['块一', '块二', '短'] } }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await translateWithTencent([longText, 'short'], baseReq);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as { SourceTextList: string[] };
    expect(body.SourceTextList.length).toBe(3);
    expect(body.SourceTextList[0].length).toBe(600); // 1800 字节 = 600 个汉字
    expect(body.SourceTextList[2]).toBe('short');
    expect(result[0]).toBe('块一\n块二');
    expect(result[1]).toBe('短');
  });

  it('keeps the 1:1 contract when input contains empty texts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ Response: { TargetTextList: ['你好', '世界'] } }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const result = await translateWithTencent(['Hi', '', 'World'], baseReq);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as { SourceTextList: string[] };
    expect(body.SourceTextList).toEqual(['Hi', 'World']); // 空文本不进请求体
    expect(result).toEqual(['你好', '', '世界']);
  });

  it('normalizes Response.Error into a typed service error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(
      new Response(
        JSON.stringify({ Response: { Error: { Code: 'AuthFailure.SignatureFailure', Message: 'signature invalid' } } }),
        { status: 200 },
      ),
    )));
    await expect(translateWithTencent(['Hi'], baseReq)).rejects.toThrow(/鉴权失败/);
    await expect(translateWithTencent(['Hi'], baseReq)).rejects.toBeInstanceOf(TranslationServiceError);
  });

  it('guards missing SecretKey with an actionable message', async () => {
    await expect(translateWithTencent(['Hi'], { ...baseReq, apiSecret: '' }))
      .rejects.toThrow(/SecretKey/);
    await expect(translateWithTencent(['Hi'], { ...baseReq, apiKey: '' }))
      .rejects.toThrow(/SecretId/);
  });

  it('retries once on RequestLimitExceeded with backoff before succeeding', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(
        new Response(JSON.stringify({ Response: { Error: { Code: 'RequestLimitExceeded', Message: 'freq' } } }), { status: 200 }),
      ))
      .mockImplementationOnce(() => Promise.resolve(
        new Response(JSON.stringify({ Response: { TargetTextList: ['你好'] } }), { status: 200 }),
      ));
    vi.stubGlobal('fetch', fetchMock);

    const promise = translateWithTencent(['hi'], baseReq);
    // 先挂上断言再推进定时器：promise 在推进期间就会 reject，
    // 晚挂 .rejects 会被 vitest 记为「异步处理的未处理拒绝」
    const assertion = expect(promise).resolves.toEqual(['你好']);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('throws after retries are exhausted for persistent rate limiting', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ Response: { Error: { Code: 'RequestLimitExceeded', Message: 'freq' } } }), { status: 200 }),
    ));
    vi.stubGlobal('fetch', fetchMock);

    const promise = translateWithTencent(['hi'], baseReq);
    const assertion = expect(promise).rejects.toThrow(/过于频繁/);
    await vi.advanceTimersByTimeAsync(1000 + 3000 + 3000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3); // 初试 + 2 次退避重试
    vi.useRealTimers();
  });
});

describe('testTencentConnection', () => {
  it('pings with a single TextTranslate and returns the translation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ Response: { TargetText: '嗨' } }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);
    await expect(testTencentConnection(baseReq)).resolves.toBe('嗨');
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['X-TC-Action']).toBe('TextTranslate');
  });
});

describe('tencentAdapter', () => {
  it('implements the MT adapter contract', () => {
    expect(tencentAdapter.id).toBe('tencent');
    expect(tencentAdapter.maxItemBytes).toBeGreaterThan(0);
    expect(tencentAdapter.translateBatch).toBe(translateWithTencent);
    expect(tencentAdapter.testConnection).toBe(testTencentConnection);
  });
});