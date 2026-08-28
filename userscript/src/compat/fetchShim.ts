/**
 * fetch shim：把脚本沙箱内的全局 fetch 指向 GM_xmlhttpRequest 适配器。
 *
 * 第一性原理：扩展中网络请求由 background 代发以绕过页面 CORS；脚本环境没有 background，
 * 但 GM_xmlhttpRequest 提供同等的跨域豁免。service 层直接调用全局 fetch，因此在**脚本
 * 沙箱内**替换 fetch（仅影响本脚本的模块查找链，页面上下文不受污染）后，service 层零改动。
 *
 * Response-like 契约（service 层实际用到的成员）：
 *   ok / status / text() / json() / headers.get(name)
 * AbortSignal 手动桥接为 GM abort；超时由 service 层自身的 30s AbortController 驱动。
 */

import { getGm } from './gm';

interface ResponseLike {
  ok: boolean;
  status: number;
  headers: { get: (name: string) => string | null };
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}

const parseResponseHeaders = (raw: string): Map<string, string> => {
  const map = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    const name = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (name) map.set(name, value);
  }
  return map;
};

const gmFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<ResponseLike> =>
  new Promise((resolve, reject) => {
    const api = getGm();
    if (!api || typeof api.xmlhttpRequest !== 'function') {
      // 无 GM 网络能力时尽力回退原生 fetch（可能因 CORS 失败，错误信息保持可读）
      window
        .fetch(input, init)
        .then((response) =>
          resolve({
            ok: response.ok,
            status: response.status,
            headers: { get: (name) => response.headers.get(name) },
            text: () => response.text(),
            json: () => response.json(),
          }),
        )
        .catch((error: unknown) => reject(error));
      return;
    }

    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      new Headers(init.headers).forEach((value, name) => {
        headers[name] = value;
      });
    }
    const signal = init?.signal ?? undefined;

    let settled = false;
    let handle: { abort: () => void } | null = null;
    const abortFromSignal = (): void => {
      try {
        handle?.abort();
      } catch {
        // 已结束的请求 abort 无害
      }
    };

    if (signal) {
      if (signal.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', abortFromSignal, { once: true });
    }

    try {
      handle = api.xmlhttpRequest({
        method,
        url,
        headers,
        data: body,
        signal,
        onload: (response) => {
          if (settled) return;
          settled = true;
          resolve({
            ok: response.status >= 200 && response.status < 300,
            status: response.status,
            headers: { get: (name) => parseResponseHeaders(response.responseHeaders).get(name.toLowerCase()) ?? null },
            text: async () => response.responseText ?? '',
            json: async () => JSON.parse(response.responseText ?? 'null'),
          });
        },
        onerror: () => {
          if (settled) return;
          settled = true;
          reject(new TypeError('网络请求失败（GM_xmlhttpRequest），请检查接口地址与网络。'));
        },
        onabort: () => {
          if (settled) return;
          settled = true;
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        },
        ontimeout: () => {
          if (settled) return;
          settled = true;
          reject(new DOMException('The operation was aborted due to timeout.', 'AbortError'));
        },
      });
    } catch (error) {
      settled = true;
      reject(error instanceof Error ? error : new TypeError('GM_xmlhttpRequest 调用失败。'));
    }
  });

/**
 * 安装 fetch shim。注意作用域：在 Tampermonkey/Via 的沙箱中，模块内对全局标识符的赋值
 * 只影响脚本自身的作用域链——页面真实的 window.fetch 不被触碰。
 */
export const installFetchShim = (): void => {
  const scope = globalThis as typeof globalThis & { fetch: typeof fetch };
  scope.fetch = gmFetch as unknown as typeof fetch;
};
