/**
 * MAIN 世界桥接脚本的通用 postMessage 通道（与站点无关）：
 * 双向校验 event.source/origin、requestId 关联回包、超时返 null。
 *
 * YouTube 沿用 protocol.ts 的专用实现；此处为 X 等新站点提供同语义的
 * 泛型版本，避免为了复用而改动已在线上验证过的 YT 类型契约。
 */

export interface BridgeEnvelope {
  source: string;
  requestId?: string;
}

/** 向页面窗口广播/请求（MAIN 世界同源接收）。 */
export const postBridgeMessage = (message: unknown): void => {
  window.postMessage(message, window.location.origin);
};

/** 校验消息事件来自本窗口且 source 匹配，防页面内其他脚本伪造。 */
export const isTrustedBridgeEvent = (event: MessageEvent, source: string): boolean =>
  event.source === window
  && event.origin === window.location.origin
  && (event.data as { source?: unknown } | null)?.source === source;

/**
 * 带超时的请求-响应：以 requestId 关联回包。
 * 桥接未注入时按超时失败返回 null，由调用方走降级路径。
 */
export const requestViaBridge = <TRes extends { requestId?: string }>(options: {
  request: BridgeEnvelope & Record<string, unknown>;
  /** 回包类型标识（与请求的 type 字段匹配）。 */
  responseType: string;
  timeoutMs: number;
  isResponseData: (data: unknown) => data is TRes;
}): Promise<TRes | null> =>
  new Promise((resolve) => {
    const { request, responseType, timeoutMs, isResponseData } = options;
    const requestId = request.requestId ?? '';
    let settled = false;
    const finish = (result: TRes | null): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(result);
    };
    const onMessage = (event: MessageEvent): void => {
      if (!isTrustedBridgeEvent(event, request.source)) return;
      const data: unknown = event.data;
      if (!isResponseData(data)) return;
      if ((data as { type?: unknown }).type !== responseType) return;
      if (data.requestId !== requestId) return;
      finish(data);
    };
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    window.addEventListener('message', onMessage);
    postBridgeMessage(request);
  });
