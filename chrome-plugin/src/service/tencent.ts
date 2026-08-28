import { TranslationServiceError, validateEndpointUrl } from './common';
import type { MtAdapter, MtTranslationRequest } from './mt';
import { rejoinChunkTranslations, splitOverlongParagraphs } from './mt';

/**
 * 腾讯云机器翻译（TMT）后端：TC3-HMAC-SHA256 签名 + TextTranslateBatch。
 * - 官方文档：https://cloud.tencent.com/document/product/551/15614（文本翻译 TextTranslate）
 * - Endpoint 与版本：https://tmt.tencentcloudapi.com，API 版本 2018-03-21（SDK 硬编码核实）
 * - 鉴权：SecretId + SecretKey 双密钥；SecretId 出现在 Authorization 的 Credential 中，
 *   SecretKey 只参与 HMAC 派生，绝不出现在请求体/URL/日志。
 * - 按字符计费：段落级缓存（translationCache）是省钱的根，本模块不做二次缓存。
 * - 无模型、无提示词、无流式：与 DeepL 同属「传统 MT」角色，实现 MtAdapter 接口。
 */

export const TENCENT_API_VERSION = '2018-03-21';
export const TENCENT_SERVICE = 'tmt';
/** 文档声明的单条文本上限（字节）。 */
export const TENCENT_MAX_ITEM_BYTES = 2000;
/** 安全切块阈值：留余量给多字节 UTF-8 与标点。 */
export const TENCENT_SAFE_ITEM_BYTES = 1800;
/** TextTranslateBatch 单次请求携带条数上限（超出由本模块分片）。 */
export const TENCENT_MAX_ITEMS_PER_CALL = 200;
/** 限流退避：RequestLimitExceeded 时依次等待后重试。 */
export const TENCENT_RETRY_DELAYS_MS = [1000, 3000];

const REQUEST_TIMEOUT_MS = 30_000;

// ── 目标语言映射（对齐 deeplTargetLang 模式） ──
export const tencentTargetLang = (targetLanguage: string): string => {
  switch (targetLanguage) {
    case '简体中文':
      return 'zh';
    case '繁體中文':
      return 'zh-TW';
    case 'English':
      return 'en';
    case '日本語':
      return 'ja';
    case '한국어':
      return 'ko';
    default:
      return 'zh';
  }
};

// ── 零依赖同步 SHA-256（CJK/凭据与签名材料的确定性哈希，双端一致、可单测） ──
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr32 = (value: number, shift: number): number => (value >>> shift) | (value << (32 - shift));

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

export const sha256Bytes = (bytes: Uint8Array): Uint8Array => {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLength = bytes.length * 8;
  const total = Math.ceil((bytes.length + 9) / 64) * 64;
  const data = new Uint8Array(total);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(total - 8, Math.floor(bitLength / 0x100000000) >>> 0);
  view.setUint32(total - 4, bitLength >>> 0);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < total; offset += 64) {
    for (let t = 0; t < 16; t += 1) w[t] = view.getUint32(offset + t * 4);
    for (let t = 16; t < 64; t += 1) {
      const s0 = rotr32(w[t - 15], 7) ^ rotr32(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr32(w[t - 2], 17) ^ rotr32(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t += 1) {
      const bigS1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + bigS1 + ch + SHA256_K[t] + w[t]) >>> 0;
      const bigS0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (bigS0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, h[i]);
  return out;
};

export const hmacSha256 = (key: Uint8Array, data: Uint8Array): Uint8Array => {
  const normalized = key.length > 64 ? sha256Bytes(key) : key;
  const ipad = new Uint8Array(64).fill(0x36);
  const opad = new Uint8Array(64).fill(0x5c);
  for (let i = 0; i < normalized.length; i += 1) {
    ipad[i] ^= normalized[i];
    opad[i] ^= normalized[i];
  }
  const inner = new Uint8Array(ipad.length + data.length);
  inner.set(ipad);
  inner.set(data, ipad.length);
  const innerHash = sha256Bytes(inner);
  const outer = new Uint8Array(opad.length + innerHash.length);
  outer.set(opad);
  outer.set(innerHash, opad.length);
  return sha256Bytes(outer);
};

export const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');

// ── TC3-HMAC-SHA256 签名 ──
export interface Tc3SigningInput {
  secretId: string;
  secretKey: string;
  host: string;
  region: string;
  action: string;
  payload: string;
  /** 注入固定时间戳便于确定性单测；缺省取当前时间。 */
  timestamp?: number;
}

export interface Tc3SigningResult {
  authorization: string;
  timestamp: number;
  date: string;
}

export const buildTc3Signing = (input: Tc3SigningInput): Tc3SigningResult => {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${input.host}\n`;
  const signedHeaders = 'content-type;host';
  const hashedPayload = bytesToHex(sha256Bytes(utf8(input.payload)));
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, hashedPayload].join('\n');
  const credentialScope = `${date}/${TENCENT_SERVICE}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    credentialScope,
    bytesToHex(sha256Bytes(utf8(canonicalRequest))),
  ].join('\n');
  const secretDate = hmacSha256(utf8(`TC3${input.secretKey}`), utf8(date));
  const secretService = hmacSha256(secretDate, utf8(TENCENT_SERVICE));
  const secretSigning = hmacSha256(secretService, utf8('tc3_request'));
  const signature = bytesToHex(hmacSha256(secretSigning, utf8(stringToSign)));
  const authorization =
    `TC3-HMAC-SHA256 Credential=${input.secretId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { authorization, timestamp, date };
};

// ── 错误归一化 ──
export const mapTencentError = (code: string, message: string): TranslationServiceError => {
  const detail = message || code;
  if (/^(AuthFailure|Signature)/i.test(code)) {
    return new TranslationServiceError(
      `腾讯翻译鉴权失败（${code}）：SecretId / SecretKey 可能有误或已过期，请到设置中检查。原始信息：${detail}`,
    );
  }
  if (/LimitExceeded|RequestLimit/i.test(code)) {
    return new TranslationServiceError(
      `腾讯翻译请求过于频繁（${code}）：已自动重试仍失败，请稍后再试。原始信息：${detail}`,
    );
  }
  if (/^(FailedOperation|InvalidParameter|ResourceNotFound|UnauthorizedOperation|UnsupportedOperation)/i.test(code)) {
    return new TranslationServiceError(`腾讯翻译请求被拒绝（${code}）：${detail}`);
  }
  return new TranslationServiceError(`腾讯翻译服务错误（${code}）：${detail}`);
};

/** 解析响应：Error 字段以对象返回（交由上层决定重试），其余只提取译文数组。 */
const parseTencentResponse = (
  text: string,
): { targetTexts?: string[]; error?: { code: string; message: string } } => {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new TranslationServiceError(`腾讯翻译返回了无法解析的内容（前 120 字符：${text.slice(0, 120)}）。`);
  }
  if (!payload || typeof payload !== 'object') {
    throw new TranslationServiceError('腾讯翻译响应不是有效的 JSON 对象。');
  }
  const response = (payload as { Response?: unknown }).Response;
  if (!response || typeof response !== 'object') {
    throw new TranslationServiceError('腾讯翻译响应缺少 Response 字段。');
  }
  const resp = response as { Error?: { Code?: string; Message?: string }; TargetTextList?: unknown; TargetText?: unknown };
  if (resp.Error && typeof resp.Error === 'object') {
    return { error: { code: String(resp.Error.Code ?? 'Unknown'), message: String(resp.Error.Message ?? '') } };
  }
  if (Array.isArray(resp.TargetTextList)) {
    return { targetTexts: resp.TargetTextList.map((item) => (typeof item === 'string' ? item : '')) };
  }
  if (typeof resp.TargetText === 'string') return { targetTexts: [resp.TargetText] };
  throw new TranslationServiceError('腾讯翻译响应缺少译文字段（TargetTextList / TargetText）。');
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new TranslationServiceError('腾讯翻译请求已取消。'));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const requestTencentOnce = async (
  request: MtTranslationRequest,
  action: string,
  payload: string,
  signal?: AbortSignal,
): Promise<{ targetTexts?: string[]; error?: { code: string; message: string } }> => {
  const host = new URL(request.endpoint).host;
  const { authorization, timestamp } = buildTc3Signing({
    secretId: request.apiKey,
    secretKey: request.apiSecret ?? '',
    host,
    region: request.region ?? '',
    action,
    payload,
  });
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abortFromCaller = (): void => controller.abort();
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    const response = await fetch(request.endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Host: host,
        Authorization: authorization,
        'X-TC-Action': action,
        'X-TC-Version': TENCENT_API_VERSION,
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Region': request.region ?? '',
      },
      body: payload,
    });
    return parseTencentResponse(await response.text());
  } catch (error) {
    if (error instanceof TranslationServiceError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new TranslationServiceError('腾讯翻译请求超过 30 秒仍未响应，请检查网络或接口地址。');
    }
    throw new TranslationServiceError(`腾讯翻译网络请求失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromCaller);
  }
};

/** 限流退避的请求封装：RequestLimitExceeded 等码等待后重试，其余错误直接抛出。 */
const requestWithTencentRetry = async (
  request: MtTranslationRequest,
  action: string,
  payload: string,
  signal?: AbortSignal,
): Promise<{ targetTexts: string[] }> => {
  for (let attempt = 0; attempt <= TENCENT_RETRY_DELAYS_MS.length; attempt += 1) {
    const parsed = await requestTencentOnce(request, action, payload, signal);
    if (parsed.error) {
      const rateLimited = /LimitExceeded|RequestLimit/i.test(parsed.error.code);
      if (rateLimited && attempt < TENCENT_RETRY_DELAYS_MS.length) {
        await sleep(TENCENT_RETRY_DELAYS_MS[attempt], signal);
        continue;
      }
      throw mapTencentError(parsed.error.code, parsed.error.message);
    }
    return { targetTexts: parsed.targetTexts ?? [] };
  }
  throw new TranslationServiceError('腾讯翻译请求过于频繁，重试后仍失败。');
};

const normalizeEndpoint = (endpoint: string): string => endpoint.trim().replace(/\/+$/, '');

/** 校验并归一化腾讯请求：Key 非空 + 接口地址安全规则与 LLM/DeepL 一致。 */
export const guardTencentRequest = (request: MtTranslationRequest): string => {
  if (!request.apiKey.trim()) throw new TranslationServiceError('请先填写 SecretId（填写在「API Key」字段）。');
  if (!request.apiSecret?.trim()) throw new TranslationServiceError('请先填写 SecretKey。');
  if (!request.endpoint.trim()) throw new TranslationServiceError('请先填写接口地址。');
  validateEndpointUrl(request.endpoint);
  return normalizeEndpoint(request.endpoint);
};

/**
 * 批量翻译：输入 N 条，按序返回 N 条。
 * - 超长段落按 TENCENT_SAFE_ITEM_BYTES 切块 → 单请求 ≤200 块 → 按原文分块归属重组；
 * - 空文本条目不进入请求体，占位空串返回，保持 1:1。
 */
export const translateWithTencent = async (
  texts: string[],
  request: MtTranslationRequest,
  signal?: AbortSignal,
): Promise<string[]> => {
  const endpoint = guardTencentRequest(request);
  const effective: MtTranslationRequest = {
    ...request,
    endpoint,
    region: request.region?.trim() || 'ap-guangzhou',
  };
  const { chunks, itemOfChunk } = splitOverlongParagraphs(texts, TENCENT_SAFE_ITEM_BYTES);
  const chunkResults: string[] = [];
  for (let offset = 0; offset < chunks.length; offset += TENCENT_MAX_ITEMS_PER_CALL) {
    const slice = chunks.slice(offset, offset + TENCENT_MAX_ITEMS_PER_CALL);
    const payload = JSON.stringify({
      SourceTextList: slice,
      Source: 'auto',
      Target: tencentTargetLang(effective.targetLanguage),
      ProjectId: 0,
    });
    const parsed = await requestWithTencentRetry(effective, 'TextTranslateBatch', payload, signal);
    const texts_ = parsed.targetTexts;
    // 服务端少返回时补空，保证下游 1:1 索引
    chunkResults.push(...texts_);
    for (let k = texts_.length; k < slice.length; k += 1) chunkResults.push('');
  }
  return rejoinChunkTranslations(chunkResults, itemOfChunk, texts.length);
};

/** 最小连通性测试：单条 TextTranslate 翻译 "hi"→zh。 */
export const testTencentConnection = async (
  request: MtTranslationRequest,
  signal?: AbortSignal,
): Promise<string> => {
  const endpoint = guardTencentRequest(request);
  const effective: MtTranslationRequest = { ...request, endpoint, region: request.region?.trim() || 'ap-guangzhou' };
  const payload = JSON.stringify({ SourceText: 'hi', Source: 'auto', Target: 'zh', ProjectId: 0 });
  const parsed = await requestWithTencentRetry(effective, 'TextTranslate', payload, signal);
  return parsed.targetTexts[0] ?? '';
};

export const tencentAdapter: MtAdapter = {
  id: 'tencent',
  maxBatchSize: TENCENT_MAX_ITEMS_PER_CALL,
  maxItemBytes: TENCENT_MAX_ITEM_BYTES,
  translateBatch: translateWithTencent,
  testConnection: testTencentConnection,
};