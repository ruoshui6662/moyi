/**
 * X（Twitter）MAIN 世界桥接脚本（document_start 注入）：
 * 在播放器发起请求前 hook fetch/XHR，收割 video.twimg.com 的 m3u8 清单体。
 *
 * X 的原生字幕挂在 HLS 主清单的 EXT-X-MEDIA:TYPE=SUBTITLES 轨道上，
 * 而主清单必然经过页面网络栈——拿到清单体即可离线解析出字幕轨道，
 * 与播放器是否开启 CC 无关。
 *
 * 本脚本运行在页面主世界，无法访问 chrome.*，只通过 window.postMessage
 * （bridgeChannel.ts 约定）与隔离世界编排脚本通信。
 */

import { isTrustedBridgeEvent, postBridgeMessage } from '../utils/subtitles/bridgeChannel';
import { logger } from '../utils/logger';

export const X_BRIDGE_SOURCE = 'moyi-x-subtitles';

/** 单条收割记录：m3u8 地址 + 响应体。 */
export interface HarvestedManifest {
  url: string;
  body: string;
  at: number;
}

/** 最多归档的清单数：覆盖「详情页连播多个视频」的近期窗口即可。 */
const MAX_ARCHIVED_MANIFESTS = 4;

/** 隔离世界 → 桥接：请求最近收割的清单体列表（新→旧）。 */
interface ManifestListResponse extends Record<string, unknown> {
  source: typeof X_BRIDGE_SOURCE;
  type: 'manifest-list';
  requestId: string;
  manifests: HarvestedManifest[];
}

const TWIMG_M3U8_RE = /^https:\/\/video\.twimg\.com\/.+\.(?:m3u8)(?:[?#]|$)/i;

const archived: HarvestedManifest[] = [];

const noteManifest = (url: string, body: string): void => {
  if (!TWIMG_M3U8_RE.test(url) || !body) return;
  // 同一地址重复加载（码率切换/重试）只刷新位置，不重复占位
  const existingIndex = archived.findIndex((item) => item.url === url);
  const entry: HarvestedManifest = { url, body, at: Date.now() };
  const isUpdate = existingIndex >= 0;
  if (isUpdate) archived.splice(existingIndex, 1);
  archived.unshift(entry);
  if (archived.length > MAX_ARCHIVED_MANIFESTS) archived.length = MAX_ARCHIVED_MANIFESTS;
  // 收割可见性：字幕链路的源头，控制台可直查是否捕获成功
  logger.info('x.bridge.manifest', { path: url.split('?')[0].slice(-60), bytes: body.length, update: isUpdate });
  try {
    postBridgeMessage({ source: X_BRIDGE_SOURCE, type: 'manifest', manifest: entry });
  } catch {
    // 结构化克隆失败（理论上不会发生）不影响播放器
  }
};

const readXhrBody = (xhr: XMLHttpRequest): string | null => {
  // 仅未设置特殊 responseType 时可读 responseText（hls.js 清单默认如此）
  const responseType = xhr.responseType as '' | 'text' | 'arraybuffer' | 'blob' | 'json' | 'document';
  if (responseType !== '' && responseType !== 'text') return null;
  try {
    const text = xhr.responseText;
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
};

const hookNetworkForManifests = (): void => {
  // XHR：hls.js 默认 loader。open 时登记 URL，load 时读响应体。
  interface HookedXhr extends XMLHttpRequest {
    __moyiUrl?: string;
    __moyiLoadHooked?: boolean;
  }
  interface HookedXhrProto extends XMLHttpRequest {
    open: (this: HookedXhr, ...args: unknown[]) => void;
    __moyiHooked?: boolean;
  }
  const proto = XMLHttpRequest.prototype as HookedXhrProto;
  if (!proto.__moyiHooked) {
    proto.__moyiHooked = true;
    const originalOpen = proto.open;
    proto.open = function patchedOpen(this: HookedXhr, ...args: unknown[]) {
      this.__moyiUrl = typeof args[1] === 'string' ? args[1] : '';
      if (!this.__moyiLoadHooked) {
        this.__moyiLoadHooked = true;
        this.addEventListener('load', () => {
          try {
            const url = this.responseURL || this.__moyiUrl || '';
            const body = readXhrBody(this);
            if (url && body !== null) noteManifest(url, body);
          } catch {
            // 收割失败绝不影响播放器本身
          }
        });
      }
      return originalOpen.apply(this, args);
    };
  }

  // fetch 兜底（若站点/hls.js 配置了 fetch loader）
  const globalWithFetch = globalThis as { fetch?: typeof fetch };
  const originalFetch = globalWithFetch.fetch;
  if (originalFetch && !(originalFetch as { __moyiHooked?: boolean }).__moyiHooked) {
    const wrappedFetch: typeof fetch = async (...args) => {
      const response = await originalFetch.apply(globalThis, args);
      try {
        const url = response.url || (typeof args[0] === 'string' ? args[0] : '');
        if (TWIMG_M3U8_RE.test(url)) {
          noteManifest(url, await response.clone().text());
        }
      } catch {
        // 忽略
      }
      return response;
    };
    (wrappedFetch as { __moyiHooked?: boolean }).__moyiHooked = true;
    globalWithFetch.fetch = wrappedFetch;
  }
};

export default defineContentScript({
  matches: ['*://*.x.com/*', '*://*.twitter.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    hookNetworkForManifests();

    window.addEventListener('message', (event: MessageEvent) => {
      if (!isTrustedBridgeEvent(event, X_BRIDGE_SOURCE)) return;
      const data = event.data as { type?: unknown; requestId?: unknown };
      if (data.type !== 'get-latest-manifests') return;
      const response: ManifestListResponse = {
        source: X_BRIDGE_SOURCE,
        type: 'manifest-list',
        requestId: typeof data.requestId === 'string' ? data.requestId : '',
        manifests: [...archived],
      };
      postBridgeMessage(response);
    });
  },
});
