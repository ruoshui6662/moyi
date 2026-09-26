/**
 * 生词本 → AnkiConnect 导出。
 *
 * 为什么走 background：内容脚本/设置页对 localhost 的 fetch 受 CORS 与私有网络策略
 * 管辖（与翻译请求同理），统一在扩展侧发起，失败一律回可读文案。
 *
 * 卡片模型（v1 固定，不给模型编辑器）：牌组「墨译生词」、笔记类型「墨译生词」，
 * 字段 = 单词 / 译名 / 上下文 / 出处，标签「墨译」；重复导入允许重复（allowDuplicate），
 * 便于反复刷新同一批生词而不报错。
 */

import type { VocabEntry } from './vocabbook';

export const ANKI_DEFAULT_ENDPOINT = 'http://127.0.0.1:8765';
export const ANKI_DECK = '墨译生词';
export const ANKI_MODEL = '墨译生词';
export const ANKI_TAG = '墨译';

export interface AnkiAction {
  action: string;
  params?: Record<string, unknown>;
}

export interface AnkiRpcResponse<T = unknown> {
  result?: T;
  error?: string | null;
}

/** 词汇条目 → Anki 字段（限长，防超长上下文撑坏笔记）。 */
export const buildAnkiFields = (entry: VocabEntry): Record<string, string> => ({
  '单词': entry.word.slice(0, 200),
  '译名': entry.translation.slice(0, 500),
  '上下文': entry.context.slice(0, 1000),
  '出处': [entry.pageTitle, entry.url].filter(Boolean).join(' · ').slice(0, 500),
});

/** 空译名时给个占位，Anki 字段不接受空串以外的缺省。 */
const nonEmpty = (value: string): string => value.trim() || '（空）';

export const buildModelCreateAction = (): AnkiAction => ({
  action: 'createModel',
  params: {
    modelName: ANKI_MODEL,
    inOrderFields: ['单词', '译名', '上下文', '出处'],
    css: '.card { font-size: 20px; text-align: left; color: #1a1a1a; background: #fdfdfd; }',
    isCloze: false,
  },
});

export const buildDeckCreateAction = (): AnkiAction => ({ action: 'createDeck', params: { deck: ANKI_DECK } });

export const buildAddNotesAction = (entries: readonly VocabEntry[]): AnkiAction => ({
  action: 'addNotes',
  params: {
    notes: entries.map((entry) => {
      const fields = buildAnkiFields(entry);
      return {
        deckName: ANKI_DECK,
        modelName: ANKI_MODEL,
        tags: [ANKI_TAG],
        options: { allowDuplicate: true },
        fields: {
          '单词': nonEmpty(fields['单词'] ?? ''),
          '译名': nonEmpty(fields['译名'] ?? ''),
          '上下文': fields['上下文'] ?? '',
          '出处': fields['出处'] ?? '',
        },
      };
    }),
  },
});

export interface AnkiCallOptions {
  endpoint?: string;
  timeoutMs?: number;
  /** 可注入 fetch（测试用）。 */
  fetchImpl?: typeof fetch;
}

/** 单次 AnkiConnect 调用；网络/协议错误转成可读文案。 */
export const callAnki = async <T = unknown>(
  action: AnkiAction,
  options: AnkiCallOptions = {},
): Promise<T> => {
  const endpoint = options.endpoint ?? ANKI_DEFAULT_ENDPOINT;
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
  try {
    const response = await doFetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
    });
    if (!response.ok) throw new Error(`AnkiConnect 返回 HTTP ${response.status}。`);
    const payload = await response.json() as AnkiRpcResponse<T>;
    if (payload.error) throw new Error(payload.error);
    if (payload.result === undefined) throw new Error('AnkiConnect 响应格式异常。');
    return payload.result;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('连接 AnkiConnect 超时（5 秒）。请确认 Anki 已启动且 AnkiConnect 插件已启用。');
    }
    if (error instanceof TypeError) {
      throw new Error('连不上 AnkiConnect（127.0.0.1:8765）：请确认已安装并启用 AnkiConnect 插件。');
    }
    throw error instanceof Error ? error : new Error('AnkiConnect 调用失败。');
  } finally {
    globalThis.clearTimeout(timer);
  }
};

export interface AnkiExportResult {
  added: number;
  modelCreated: boolean;
  deckCreated: boolean;
}

/**
 * 完整导出：确保模型/牌组存在 → 批量写入。
 * 逐步容错：模型或牌组不存在时自动创建（AnkiConnect 无幂等创建接口，先查再建）。
 */
export const exportVocabToAnki = async (
  entries: readonly VocabEntry[],
  options: AnkiCallOptions = {},
): Promise<AnkiExportResult> => {
  if (entries.length === 0) throw new Error('生词本为空，没有可导出的生词。');
  const modelNames = await callAnki<string[]>({ action: 'modelNames' }, options);
  const modelCreated = !modelNames.includes(ANKI_MODEL);
  if (modelCreated) await callAnki(buildModelCreateAction(), options);
  const deckNames = await callAnki<string[]>({ action: 'deckNames' }, options);
  const deckCreated = !deckNames.includes(ANKI_DECK);
  if (deckCreated) await callAnki(buildDeckCreateAction(), options);
  const noteIds = await callAnki<unknown[]>(buildAddNotesAction(entries), options);
  return { added: Array.isArray(noteIds) ? noteIds.filter((id) => id !== null).length : entries.length, modelCreated, deckCreated };
};
