export interface TranslateMessage {
  type: 'translate';
  text: string;
  /** 跨批上文（同文档相邻原文段，仅注入 prompt）。 */
  precedingParagraphs?: string[];
}

export interface TranslateResponse {
  ok: boolean;
  translation?: string;
  error?: string;
}

export const requestTranslation = async (text: string, precedingParagraphs?: string[]): Promise<string> => {
  const response = await chrome.runtime.sendMessage({ type: 'translate', text, precedingParagraphs } satisfies TranslateMessage) as TranslateResponse;
  if (!response?.ok || !response.translation) throw new Error(response?.error || '翻译失败。');
  return response.translation;
};

export interface LookupWordMessage {
  type: 'lookup-word';
  text: string;
}

export interface LookupWordResponse {
  ok: boolean;
  /** true = 当前服务商为传统 MT，无语言模型，不支持查词。 */
  unsupported?: boolean;
  result?: unknown;
  error?: string;
}

/** 划词查词请求；失败/不支持抛错（由调用方展示文案）。 */
export const requestWordLookup = async (text: string): Promise<unknown> => {
  const response = await chrome.runtime.sendMessage({ type: 'lookup-word', text } satisfies LookupWordMessage) as LookupWordResponse;
  if (!response?.ok) {
    const error = new Error(response?.error || '查词失败。') as Error & { unsupported?: boolean };
    error.unsupported = response?.unsupported === true;
    throw error;
  }
  return response.result;
};

export interface ExplainWordMessage {
  type: 'explain-word';
  text: string;
  level?: string;
  context?: string;
  /** true = 追问模式（携带会话历史）；缺省 = 首次详解。 */
  followup?: boolean;
  history?: { role: 'user' | 'assistant'; content: string }[];
}

export interface ExplainWordResponse {
  ok: boolean;
  unsupported?: boolean;
  result?: unknown;
  error?: string;
}

/** 阅读卡详解/追问请求；失败/不支持抛错（unsupported 标记与查词同源）。 */
export const requestExplain = async (message: ExplainWordMessage): Promise<unknown> => {
  const response = await chrome.runtime.sendMessage(message) as ExplainWordResponse;
  if (!response?.ok) {
    const error = new Error(response?.error || '讲解失败。') as Error & { unsupported?: boolean };
    error.unsupported = response?.unsupported === true;
    throw error;
  }
  return response.result;
};

/** Edge 云端语音请求（合成在 background 侧完成，content 只收音频）。 */
export const requestEdgeSpeech = async (text: string, voice: string, rate: number): Promise<Uint8Array> => {
  const response = await chrome.runtime.sendMessage({ type: 'edge-tts-speak', text, voice, rate }) as
    { ok: boolean; audio?: string; error?: string };
  if (!response?.ok || !response.audio) throw new Error(response?.error || '云端语音合成失败。');
  const binary = atob(response.audio);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

export interface BatchTranslateRequest {
  type: 'translate-batch';
  paragraphs: string[];
  maxBatchSize?: number;
  pageContext?: string;
  /** 跨批上文：MT 通道忽略（无提示词）。 */
  precedingParagraphs?: string[];
}

export interface BatchTranslateResponse {
  ok: boolean;
  translations?: string[];
  error?: string;
}

export const requestBatchTranslation = async (
  paragraphs: string[],
  maxBatchSize?: number,
  pageContext?: string,
  precedingParagraphs?: string[],
): Promise<string[]> => {
  const response = await chrome.runtime.sendMessage({
    type: 'translate-batch',
    paragraphs,
    maxBatchSize,
    pageContext,
    precedingParagraphs,
  } satisfies BatchTranslateRequest) as BatchTranslateResponse;
  if (!response?.ok || !Array.isArray(response.translations)) throw new Error(response?.error || '批量翻译失败。');
  return response.translations;
};

export const extractPageContext = (): string => {
  const title = document.title ? document.title.trim() : '';
  const description = document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '';
  const parts = [title, description].filter(Boolean);
  return parts.length > 0 ? `Page context - Title: ${title}${description ? ' | Description: ' + description : ''}` : '';
};

export interface StreamBatchCallbacks {
  maxBatchSize?: number;
  pageContext?: string;
  /** 跨批上文（同文档相邻原文段）。 */
  precedingParagraphs?: string[];
  onPartial: (index: number, text: string) => void;
  onParagraph: (index: number, text: string) => void;
  onError: (error: string) => void;
  /** truncated=true 表示服务商以 finish_reason=length 结束，输出被截断。 */
  onDone: (completedCount: number, truncated?: boolean) => void;
}

export interface StreamHandle {
  abort: () => void;
}

export const streamBatchTranslation = (
  paragraphs: string[],
  callbacks: StreamBatchCallbacks,
): StreamHandle => {
  const port = chrome.runtime.connect({ name: 'translate-batch-stream' });
  let settled = false;

  port.onMessage.addListener((message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const msg = message as { type?: string; index?: number; text?: string; error?: string; completedCount?: number; truncated?: boolean };
    if (msg.type === 'partial' && typeof msg.index === 'number' && typeof msg.text === 'string') {
      callbacks.onPartial(msg.index, msg.text);
    } else if (msg.type === 'paragraph' && typeof msg.index === 'number' && typeof msg.text === 'string') {
      callbacks.onParagraph(msg.index, msg.text);
    } else if (msg.type === 'error') {
      if (settled) return;
      settled = true;
      callbacks.onError(msg.error || '流式翻译失败。');
      port.disconnect();
    } else if (msg.type === 'done') {
      if (settled) return;
      settled = true;
      callbacks.onDone(msg.completedCount ?? 0, msg.truncated ?? false);
      port.disconnect();
    }
  });

  port.onDisconnect.addListener(() => {
    if (!settled) {
      settled = true;
      callbacks.onError('翻译连接已中断。');
    }
  });

  port.postMessage({
    type: 'start',
    paragraphs,
    maxBatchSize: callbacks.maxBatchSize,
    pageContext: callbacks.pageContext,
    precedingParagraphs: callbacks.precedingParagraphs,
  });

  return {
    abort: () => {
      settled = true;
      try {
        port.disconnect();
      } catch {
        // 端口已关闭
      }
    },
  };
};
