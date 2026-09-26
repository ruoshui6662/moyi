/**
 * 生词本：划词卡一键收藏，带上下文与出处存储；独立存储键（不进 TranslatorConfig——
 * 生词由内容脚本与设置页双端写入，独立键避免整份配置互踩）。
 *
 * 去重语义（Saladict 式带上下文存储）：
 * - 同词同页 → 覆盖（更新译名/上下文/时间，只留一条）；
 * - 同词异页 → 追加（同一词在不同文章里的语境各自保留）；
 * - 词归一化大小写不敏感（Kubernetes 与 kubernetes 视为同词）。
 * 容量合同：超 VOCABBOOK_MAX_ENTRIES 丢最旧（按 createdAt）。
 */

export const VOCABBOOK_STORAGE_KEY = 'moyi-vocabbook';
export const VOCABBOOK_MAX_ENTRIES = 2000;

export interface VocabEntry {
  /** 收藏的原词/原句（清洗后的查询文本）。 */
  word: string;
  /** 词卡给出的译名/释义首行。 */
  translation: string;
  /** 选区所在段落的原句（截断）。 */
  context: string;
  /** 收藏时的页面标题。 */
  pageTitle: string;
  /** 收藏时的页面地址（归一化：origin + pathname，去 query/hash）。 */
  url: string;
  /** 收藏时间（epoch ms）。 */
  createdAt: number;
}

const WORD_MAX = 80;
const TRANSLATION_MAX = 200;
const CONTEXT_MAX_CHARS = 160;
const TITLE_MAX = 120;
const URL_MAX = 500;

/** 页面身份键：query/hash 是会话状态，不该参与「同页」判定。 */
export const vocabPageKey = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.slice(0, URL_MAX);
  }
};

const vocabEntryKey = (entry: Pick<VocabEntry, 'word' | 'url'>): string =>
  `${entry.word.trim().toLowerCase()}\u0000${vocabPageKey(entry.url)}`;

const cap = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** 清洗词表：丢非法条目、限长、按键去重（保留 createdAt 最新者）、超容量丢最旧。 */
export const sanitizeVocabEntries = (value: unknown): VocabEntry[] => {
  if (!Array.isArray(value)) return [];
  const byKey = new Map<string, VocabEntry>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as Partial<VocabEntry>;
    const word = cap(candidate.word, WORD_MAX);
    if (!word) continue;
    const entry: VocabEntry = {
      word,
      translation: cap(candidate.translation, TRANSLATION_MAX),
      context: cap(candidate.context, CONTEXT_MAX_CHARS),
      pageTitle: cap(candidate.pageTitle, TITLE_MAX),
      url: cap(candidate.url, URL_MAX),
      createdAt: typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)
        ? candidate.createdAt
        : 0,
    };
    const key = vocabEntryKey(entry);
    const existing = byKey.get(key);
    if (!existing || entry.createdAt >= existing.createdAt) byKey.set(key, entry);
  }
  const entries = [...byKey.values()].sort((a, b) => a.createdAt - b.createdAt);
  return entries.length > VOCABBOOK_MAX_ENTRIES ? entries.slice(entries.length - VOCABBOOK_MAX_ENTRIES) : entries;
};

/** 纯 upsert：同词同页覆盖，异页追加；超容量丢最旧。 */
export const upsertVocabEntry = (
  entries: readonly VocabEntry[],
  entry: VocabEntry,
): { entries: VocabEntry[]; updated: boolean } => {
  const key = vocabEntryKey(entry);
  const existingIndex = entries.findIndex((item) => vocabEntryKey(item) === key);
  const next = [...entries];
  let updated = false;
  if (existingIndex >= 0) {
    next[existingIndex] = entry;
    updated = true;
  } else {
    next.push(entry);
  }
  const sanitized = sanitizeVocabEntries(next);
  return { entries: sanitized, updated };
};

/** 本地时间 `YYYY-MM-DD HH:mm:ss`（表格可读、可排序）。 */
export const formatVocabDate = (ts: number): string => {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

/** RFC 4180 转义：含引号/逗号/换行/分号的字段加引号并双写引号。 */
const csvField = (value: string): string =>
  /["',;\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

/** CSV 导出：BOM 头保证 Excel/WPS 直接打开不乱码；CRLF 行尾。 */
export const toVocabCsv = (entries: readonly VocabEntry[]): string => {
  const header = ['单词', '译名', '上下文', '页面标题', '网址', '收藏时间'];
  const rows = entries.map((entry) => [
    entry.word,
    entry.translation,
    entry.context,
    entry.pageTitle,
    entry.url,
    formatVocabDate(entry.createdAt),
  ].map(csvField).join(','));
  return `\uFEFF${header.map(csvField).join(',')}\r\n${rows.join('\r\n')}`;
};

/** JSON 导出（可直接再导入的完整数据）。 */
export const toVocabJson = (entries: readonly VocabEntry[]): string => JSON.stringify(entries, null, 2);

export const loadVocabBook = async (): Promise<VocabEntry[]> => {
  const result = await chrome.storage.local.get(VOCABBOOK_STORAGE_KEY);
  return sanitizeVocabEntries(result[VOCABBOOK_STORAGE_KEY]);
};

export const saveVocabBook = async (entries: readonly VocabEntry[]): Promise<void> => {
  await chrome.storage.local.set({ [VOCABBOOK_STORAGE_KEY]: sanitizeVocabEntries(entries) });
};
