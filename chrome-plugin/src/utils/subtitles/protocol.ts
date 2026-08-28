/**
 * MAIN 世界桥接脚本 ↔ 隔离世界编排脚本 的 postMessage 协议。
 *
 * MAIN 世界脚本无法访问 chrome.*，只能通过 window.postMessage 与隔离世界通信。
 * 双方同源运行，仍校验 event.source === window 且 origin 一致，
 * 防止页面内其他脚本/iframe 伪造消息驱动字幕流程。
 */

export const BRIDGE_SOURCE = 'moyi-yt-subtitles';

/** captionTracks 中单条字幕轨道的最小描述（仅保留取轨与拼 URL 所需字段）。 */
export interface CaptionTrackInfo {
  baseUrl: string;
  languageCode: string;
  /** 'asr' = 自动语音识别字幕；缺省为人工字幕。 */
  kind?: string;
  name?: string;
  vssId?: string;
}

export interface PlayerDataPayload {
  videoId: string;
  tracks: CaptionTrackInfo[];
  /**
   * 音轨字幕轨道：其 baseUrl 通常自带 pot/potc 风控令牌，
   * 是「收割 PO Token」的首要来源（参考陪读蛙实现）。
   */
  audioTracks: CaptionTrackInfo[];
  /** ytcfg DEVICE 设备指纹（timedtext 请求参数所需）。 */
  device: Record<string, string> | null;
  /** 播放器上下文版本（innertubeContextClientVersion）。 */
  cver: string | null;
}

interface BridgeMessageBase {
  source: typeof BRIDGE_SOURCE;
  requestId?: string;
}

export type BridgeRequest =
  | (BridgeMessageBase & { type: 'get-player-data'; requestId: string })
  | (BridgeMessageBase & { type: 'toggle-subtitles'; requestId: string });

export type BridgeResponse =
  | (BridgeMessageBase & {
      type: 'player-data';
      requestId: string;
      payload: PlayerDataPayload | null;
      error?: string;
    })
  | (BridgeMessageBase & { type: 'subtitles-toggled'; requestId: string; handled?: boolean })
  // 桥接脚本主动广播：捕获到播放器自己发出的含 pot 的 timedtext 地址
  | (BridgeMessageBase & { type: 'pot-url'; videoId: string; url: string });

export const isBridgeRequest = (data: unknown): data is BridgeRequest =>
  typeof data === 'object'
  && data !== null
  && (data as { source?: unknown }).source === BRIDGE_SOURCE
  && typeof (data as { type?: unknown }).type === 'string';

export const isBridgeResponse = (data: unknown): data is BridgeResponse =>
  isBridgeRequest(data);

/** 隔离世界 → 桥接：发起请求。 */
export const sendBridgeRequest = (message: BridgeRequest): void => {
  window.postMessage(message, window.location.origin);
};

/**
 * 带超时的请求-响应：以 requestId 关联桥接回包。
 * 桥接未注入（旧内核/注入失败）时按超时失败，由调用方走降级路径。
 */
export const requestFromBridge = <T extends BridgeResponse>(
  message: BridgeRequest,
  matchType: T['type'],
  timeoutMs: number,
): Promise<Exclude<T, { type: 'pot-url' }> | null> =>
  new Promise((resolve) => {
    const requestId = message.requestId ?? '';
    let settled = false;
    const finish = (result: Exclude<T, { type: 'pot-url' }> | null): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(result);
    };
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data: unknown = event.data;
      if (!isBridgeResponse(data) || data.type !== matchType) return;
      if ('requestId' in data && data.requestId !== requestId) return;
      finish(data as Exclude<T, { type: 'pot-url' }>);
    };
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    window.addEventListener('message', onMessage);
    sendBridgeRequest(message);
  });
