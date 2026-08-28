export interface TranslateMessage {
  type: 'translate';
  text: string;
}

export interface TranslateResponse {
  ok: boolean;
  translation?: string;
  error?: string;
}

export const requestTranslation = async (text: string): Promise<string> => {
  const response = await chrome.runtime.sendMessage({ type: 'translate', text } satisfies TranslateMessage) as TranslateResponse;
  if (!response?.ok || !response.translation) throw new Error(response?.error || '翻译失败。');
  return response.translation;
};

export interface BatchTranslateRequest {
  type: 'translate-batch';
  paragraphs: string[];
  maxBatchSize?: number;
  pageContext?: string;
}

export interface BatchTranslateResponse {
  ok: boolean;
  translations?: string[];
  error?: string;
}

export const requestBatchTranslation = async (paragraphs: string[], maxBatchSize?: number, pageContext?: string): Promise<string[]> => {
  const response = await chrome.runtime.sendMessage({
    type: 'translate-batch',
    paragraphs,
    maxBatchSize,
    pageContext,
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
  onPartial: (index: number, text: string) => void;
  onParagraph: (index: number, text: string) => void;
  onError: (error: string) => void;
  onDone: (completedCount: number) => void;
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
    const msg = message as { type?: string; index?: number; text?: string; error?: string; completedCount?: number };
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
      callbacks.onDone(msg.completedCount ?? 0);
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
