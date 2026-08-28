/**
 * GM API 能力检测与最小类型声明。
 *
 * 第一性原理：目标环境（Tampermonkey / Violentmonkey / Via）提供的 GM 能力面参差不齐，
 * 一切能力都必须 typeof 探测后使用，缺失即降级——不假设、不硬崩。
 * 类型声明只覆盖本脚本实际用到的成员，保持最小面。
 */

interface GmXmlHttpRequestDetails {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  data?: string;
  timeout?: number;
  signal?: AbortSignal;
  onprogress?: (response: { responseText?: string; loaded?: number; total?: number }) => void;
  onload?: (response: { status: number; responseText: string; responseHeaders: string }) => void;
  onerror?: (response: { error?: string; status?: number }) => void;
  onabort?: () => void;
  ontimeout?: () => void;
}

export interface GmApi {
  getValue(key: string): unknown;
  setValue(key: string, value: unknown): void;
  deleteValue(key: string): void;
  xmlhttpRequest(details: GmXmlHttpRequestDetails): { abort: () => void };
}

declare const GM_getValue: unknown;
declare const GM_setValue: unknown;
declare const GM_deleteValue: unknown;
declare const GM_xmlhttpRequest: unknown;
declare const GM_addValueChangeListener: unknown;
declare const GM_registerMenuCommand: unknown;

/** 值变更监听回调：remote=true 表示变更来自其他标签页/上下文。 */
export type ValueChangeListener = (
  key: string,
  oldValue: unknown,
  newValue: unknown,
  remote: boolean,
) => void;

let warnedNoGm = false;

/** GM 存储 + 网络的探测入口；无任何 GM 能力时返回 null。每次调用即时探测，不做缓存。 */
export const getGm = (): GmApi | null => {
  if (typeof GM_getValue === 'function' && typeof GM_setValue === 'function') {
    return {
      getValue: GM_getValue as GmApi['getValue'],
      setValue: GM_setValue as GmApi['setValue'],
      deleteValue: typeof GM_deleteValue === 'function' ? (GM_deleteValue as GmApi['deleteValue']) : (): void => {},
      xmlhttpRequest:
        typeof GM_xmlhttpRequest === 'function' ? (GM_xmlhttpRequest as GmApi['xmlhttpRequest']) : (null as never),
    };
  }
  if (!warnedNoGm) {
    warnedNoGm = true;
    console.debug('[PersonalTranslator] GM API 不可用，存储降级为站点级。');
  }
  return null;
};

/** 是否具备 GM 跨域网络能力（流式传输与跨域请求的前提）。 */
export const hasGmXhr = (): boolean => {
  const api = getGm();
  return api !== null && typeof api.xmlhttpRequest === 'function';
};

/** 跨上下文值变更监听；惰性探测，管理器不支持时返回 null（配置热同步静默降级）。 */
export const getAddValueChangeListener =
  (): ((key: string, listener: ValueChangeListener) => number) | null =>
    typeof GM_addValueChangeListener === 'function'
      ? (GM_addValueChangeListener as (key: string, listener: ValueChangeListener) => number)
      : null;

/** 管理器菜单注册；惰性探测，不支持时返回 null（以悬浮按钮长按作为设置入口兜底）。 */
export const getRegisterMenuCommand =
  (): ((caption: string, onClick: () => void) => unknown) | null =>
    typeof GM_registerMenuCommand === 'function'
      ? (GM_registerMenuCommand as (caption: string, onClick: () => void) => unknown)
      : null;
