/**
 * YouTube MAIN 世界桥接脚本（document_start 注入）：
 * 1. 在播放器发起请求前 hook fetch/XHR，收割自带 pot 令牌的 timedtext 地址（风控通行证）；
 * 2. 响应隔离世界的请求，直接调用播放器 API 取 captionTracks / 设备指纹 / 强开字幕。
 *
 * 本脚本运行在页面主世界，无法访问 chrome.*，只通过 protocol.ts 约定的
 * postMessage 与编排脚本通信。
 */

import {
  BRIDGE_SOURCE,
  isBridgeRequest,
  type BridgeResponse,
  type CaptionTrackInfo,
} from '../utils/subtitles/protocol';

/** 播放器对象的最小方法面：全部运行时探测，缺失则走降级路径。 */
interface PlayerCaptionTrackRaw {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
  vssId?: string;
  name?: { simpleText?: string; runs?: { text?: string }[] };
}

interface PlayerResponseRaw {
  videoDetails?: { videoId?: string };
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: PlayerCaptionTrackRaw[] } };
}

interface YTPlayerLike {
  getPlayerResponse?: () => unknown;
  getAudioTrack?: () => unknown;
  getOption?: (namespace: string, option: string) => unknown;
  toggleSubtitles?: () => void;
  getPlayerState?: () => number | string | undefined;
  getWebPlayerContextConfig?: () => { innertubeContextClientVersion?: string } | undefined;
}

interface YtcfgLike {
  get?: (key: string) => unknown;
}

const getPlayer = (): YTPlayerLike | null =>
  (document.querySelector('#movie_player') ?? document.querySelector('.html5-video-player')) as YTPlayerLike | null;

const getYtcfg = (): YtcfgLike | null =>
  (globalThis as { ytcfg?: YtcfgLike }).ytcfg ?? null;

const normalizeTracks = (raw: unknown): CaptionTrackInfo[] => {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): CaptionTrackInfo[] => {
    const track = item as PlayerCaptionTrackRaw;
    if (typeof track?.baseUrl !== 'string' || typeof track?.languageCode !== 'string') return [];
    return [{
      baseUrl: track.baseUrl,
      languageCode: track.languageCode,
      kind: typeof track.kind === 'string' ? track.kind : undefined,
      vssId: typeof track.vssId === 'string' ? track.vssId : undefined,
      name: track.name?.simpleText ?? track.name?.runs?.[0]?.text,
    }];
  });
};

const broadcast = (message: BridgeResponse): void => {
  window.postMessage(message, window.location.origin);
};

// ── PO Token 收割：播放器自己发出的 timedtext 请求必然携带有效令牌 ──

const notePotUrl = (url: unknown): void => {
  if (typeof url !== 'string' || !url.includes('/api/timedtext') || !url.includes('pot=')) return;
  let videoId = '';
  try {
    videoId = new URL(url, window.location.origin).searchParams.get('v') ?? '';
  } catch {
    return;
  }
  if (!videoId) return;
  broadcast({ source: BRIDGE_SOURCE, type: 'pot-url', videoId, url });
};

const hookNetworkForPot = (): void => {
  // XHR：open 时挂一次性 load 监听读取 responseURL
  const proto = XMLHttpRequest.prototype as XMLHttpRequestPrototypeWithHook;
  if (!proto.__moyiPotHooked) {
    proto.__moyiPotHooked = true;
    const originalOpen = proto.open;
    proto.open = function patchedOpen(this: HookedXhr, ...args: Parameters<typeof originalOpen>) {
      if (!this.__moyiLoadHooked) {
        this.__moyiLoadHooked = true;
        this.addEventListener('load', () => {
          try {
            notePotUrl(this.responseURL);
          } catch {
            // 读取 responseURL 失败不影响播放器本身
          }
        });
      }
      return originalOpen.apply(this, args);
    };
  }

  // fetch：包装全局，成功后检查最终 URL（跟随重定向后的地址才含 pot）
  const globalWithFetch = globalThis as { fetch?: typeof fetch };
  const originalFetch = globalWithFetch.fetch;
  if (originalFetch && !(originalFetch as FetchWithHook).__moyiPotHooked) {
    const wrappedFetch: typeof fetch = async (...args) => {
      const response = await originalFetch.apply(globalThis, args);
      try {
        notePotUrl(response.url);
      } catch {
        // 忽略
      }
      return response;
    };
    (wrappedFetch as FetchWithHook).__moyiPotHooked = true;
    globalWithFetch.fetch = wrappedFetch;
  }
};

interface HookedXhr extends XMLHttpRequest {
  __moyiLoadHooked?: boolean;
}

interface XMLHttpRequestPrototypeWithHook extends XMLHttpRequest {
  open: (this: HookedXhr, ...args: unknown[]) => void;
  __moyiPotHooked?: boolean;
}

interface FetchWithHook extends Function {
  __moyiPotHooked?: boolean;
}

// ── 请求处理：取播放器数据 / 强制开启字幕触发 timedtext 请求 ──

const buildPlayerData = (): { payload: unknown; error?: string } => {
  const player = getPlayer();
  if (!player) return { payload: null, error: '播放器未就绪。' };

  let playerResponse: PlayerResponseRaw | null = null;
  try {
    playerResponse = (player.getPlayerResponse?.() ?? null) as PlayerResponseRaw | null;
  } catch {
    playerResponse = null;
  }

  let audioTracksRaw: unknown;
  try {
    audioTracksRaw = player.getAudioTrack?.() ?? null;
  } catch {
    audioTracksRaw = null;
  }

  const ytcfg = getYtcfg();
  let device: Record<string, string> | null = null;
  try {
    const rawDevice = ytcfg?.get?.('DEVICE');
    if (rawDevice && typeof rawDevice === 'object') {
      device = rawDevice as Record<string, string>;
    }
  } catch {
    device = null;
  }

  let cver: string | null = null;
  try {
    cver = player.getWebPlayerContextConfig?.()?.innertubeContextClientVersion
      ?? (typeof ytcfg?.get?.('INNERTUBE_CONTEXT_CLIENT_VERSION') === 'string'
        ? (ytcfg.get('INNERTUBE_CONTEXT_CLIENT_VERSION') as string)
        : null);
  } catch {
    cver = null;
  }

  const tracks = normalizeTracks(playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks);
  const audioTracks = normalizeTracks((audioTracksRaw as { captionTracks?: unknown } | null)?.captionTracks);
  const videoId = playerResponse?.videoDetails?.videoId ?? '';

  if (!videoId && tracks.length === 0 && audioTracks.length === 0) {
    return { payload: null, error: '播放器未返回字幕数据。' };
  }
  return {
    payload: { videoId, tracks, audioTracks, device, cver },
  };
};

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    hookNetworkForPot();

    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data: unknown = event.data;
      if (!isBridgeRequest(data)) return;

      if (data.type === 'get-player-data') {
        const { payload, error } = buildPlayerData();
        broadcast({
          source: BRIDGE_SOURCE,
          type: 'player-data',
          requestId: data.requestId,
          payload: payload as never,
          ...(error ? { error } : {}),
        });
        return;
      }

      if (data.type === 'toggle-subtitles') {
        // 确保原生字幕处于「开启」状态，促使播放器自己发一次带令牌的 timedtext 请求供收割。
        // 注意只能"确保开启"、不能盲目 toggle：若字幕本来就开着，盲切会把它关掉，
        // 播放器反而不再请求 timedtext（收割落空的真实教训）。
        let handled = false;
        try {
          const ccButton = document.querySelector<HTMLButtonElement>('.ytp-subtitles-button');
          const isOn = ccButton?.getAttribute('aria-pressed') === 'true';
          if (!isOn) {
            const player = getPlayer();
            if (typeof player?.toggleSubtitles === 'function') {
              player.toggleSubtitles();
              handled = true;
            } else if (ccButton) {
              ccButton.click();
              handled = true;
            }
          } else {
            // 已开启则不动，避免反向关闭
            handled = true;
          }
        } catch {
          handled = false;
        }
        broadcast({ source: BRIDGE_SOURCE, type: 'subtitles-toggled', requestId: data.requestId, handled });
      }
    });
  },
});
