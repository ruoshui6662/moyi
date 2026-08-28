/**
 * 段落级译文缓存：按「目标语言 + 原文 hash」缓存译文，同一文本再次翻译时
 * 直接命中渲染，不发模型请求——省 token 且命中即时显示。
 *
 * 存储：`chrome.storage.local` 独立键（扩展私有，不污染页面与插件配置）；
 * 完整表一次读入/一次刷写；超期（默认 7 天）与超容量（默认 5000 条）自动淘汰。
 */

export const TRANSLATION_CACHE_KEY = 'moyi-translation-cache';

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

interface CacheEntry {
  t: string;
  at: number;
}

export type TranslationCache = Record<string, CacheEntry>;

const now = (): number => Date.now();

/** 稳定、快速的非加密 hash（djb2），用于缓存键。 */
export const hashText = (text: string): string => {
  let hash = 5381;
  const value = text.trim();
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
};

/** 缓存键 = 目标语言 + hash + 长度，避免碰撞与跨语言串用。 */
export const cacheKey = (language: string, text: string): string => {
  const trimmed = text.trim();
  return `${language}:${hashText(trimmed)}:${trimmed.length}`;
};

const readTable = async (): Promise<TranslationCache> => {
  try {
    const stored = await chrome.storage.local.get(TRANSLATION_CACHE_KEY);
    return (stored[TRANSLATION_CACHE_KEY] as TranslationCache | undefined) ?? {};
  } catch {
    return {};
  }
};

const writeTable = async (table: TranslationCache): Promise<void> => {
  try {
    await chrome.storage.local.set({ [TRANSLATION_CACHE_KEY]: table });
  } catch {
    // 存储不可用（配额等）时静默降级，不影响翻译
  }
};

/** 加载整表并剔除过期条目；返回去过期后的副本。 */
export const loadTranslationCache = async (): Promise<TranslationCache> => {
  const table = await readTable();
  const cutoff = now() - TTL_MS;
  let pruned = false;
  for (const [key, entry] of Object.entries(table)) {
    if (entry.at < cutoff || typeof entry.t !== 'string') {
      delete table[key];
      pruned = true;
    }
  }
  if (pruned) await writeTable(table);
  return table;
};

/** 追加多条缓存并淘汰超量最旧条目，一次性写回。 */
export const saveTranslationCache = async (
  table: TranslationCache,
  pairs: { language: string; text: string; translation: string }[],
): Promise<void> => {
  if (pairs.length === 0) return;
  const at = now();
  for (const pair of pairs) {
    const translation = pair.translation.trim();
    if (!translation) continue;
    table[cacheKey(pair.language, pair.text)] = { t: translation, at };
  }
  const keys = Object.keys(table);
  if (keys.length > MAX_ENTRIES) {
    const sorted = keys
      .map((key) => ({ key, at: table[key].at }))
      .sort((a, b) => a.at - b.at);
    const removeCount = keys.length - MAX_ENTRIES;
    for (let i = 0; i < removeCount; i += 1) {
      delete table[sorted[i].key];
    }
  }
  await writeTable(table);
};

/** 清空全部译文缓存（恢复出厂时调用）。 */
export const clearTranslationCache = async (): Promise<void> => {
  try {
    await chrome.storage.local.remove(TRANSLATION_CACHE_KEY);
  } catch {
    // 清理失败不影响翻译
  }
};