/**
 * 术语表（Glossary）：用户固定「原词 → 译名」，双通道生效——
 * - OpenAI 兼容族：命中的条目注入 system 提示词，措辞显式压过「专有名词保留原文」的默认规则；
 * - 传统 MT 族（DeepL/腾讯/微软/谷歌）：无提示词可用，在译文产出后按词边界替换。
 * 纯函数模块：sanitize 供 config 存储层调用；命中扫描与替换供 service / background 调用。
 */

export interface GlossaryEntry {
  /** 原词（原文语言）。 */
  term: string;
  /** 固定译名（目标语言）。 */
  translation: string;
}

/** 容量合同：条数与单条长度上限，防存储被污染时 prompt 无限膨胀。 */
export const GLOSSARY_MAX_ENTRIES = 100;
export const GLOSSARY_TEXT_MAX_CHARS = 80;
/** 单次请求注入的命中条目上限：意外大面积命中时按词表顺序截断。 */
export const GLOSSARY_MAX_HITS_PER_REQUEST = 32;

/**
 * 清洗词表：丢弃非对象/空字段条目；trim 后限长；
 * 按 term 大小写不敏感去重（保留先出现者——同一原词只允许一个固定译名）；限总条数。
 */
export const sanitizeGlossary = (value: unknown): GlossaryEntry[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: GlossaryEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const term = typeof (raw as { term?: unknown }).term === 'string' ? (raw as { term: string }).term.trim() : '';
    const translation = typeof (raw as { translation?: unknown }).translation === 'string'
      ? (raw as { translation: string }).translation.trim()
      : '';
    if (!term || !translation) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      term: term.slice(0, GLOSSARY_TEXT_MAX_CHARS),
      translation: translation.slice(0, GLOSSARY_TEXT_MAX_CHARS),
    });
    if (out.length >= GLOSSARY_MAX_ENTRIES) break;
  }
  return out;
};

/**
 * 命中扫描：返回在 texts 中出现过的条目（大小写不敏感），按词表顺序截断到
 * GLOSSARY_MAX_HITS_PER_REQUEST。只注入命中项——未命中批的请求体与不启用词表时完全一致。
 */
export const filterGlossaryHits = (
  entries: readonly GlossaryEntry[] | undefined,
  texts: readonly string[],
): GlossaryEntry[] => {
  if (!entries || entries.length === 0 || texts.length === 0) return [];
  const haystacks = texts.map((text) => text.toLowerCase());
  const hits: GlossaryEntry[] = [];
  for (const entry of entries) {
    const needle = entry.term.toLowerCase();
    if (haystacks.some((hay) => hay.includes(needle))) {
      hits.push(entry);
      if (hits.length >= GLOSSARY_MAX_HITS_PER_REQUEST) break;
    }
  }
  return hits;
};

/** 粘贴导入支持的分隔符（取行内最先出现者，按此顺序优先）。 */
const GLOSSARY_SEPARATORS = ['→', '=>', '->', '\t', '|', '，', ',', '；', ';'] as const;

/**
 * 解析用户粘贴的文本 → 词表。逐行：`#`/`//` 开头视为注释跳过；
 * 含分隔符的行按最先出现的分隔符切成「原词 / 译名」，无分隔符或任一侧为空的行跳过；
 * 整段以 `[` 或 `{` 开头时按 JSON 解析（导出文件的文本可直接粘贴回来）。
 * 结果一律走 sanitizeGlossary 收口（长度/条数/去重）。
 */
export const parseGlossaryText = (text: string): GlossaryEntry[] => {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      return sanitizeGlossary(JSON.parse(trimmed));
    } catch {
      return [];
    }
  }
  const entries: GlossaryEntry[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const row = line.trim();
    if (!row || row.startsWith('#') || row.startsWith('//')) continue;
    let splitAt = -1;
    let sepLength = 0;
    for (const sep of GLOSSARY_SEPARATORS) {
      const idx = row.indexOf(sep);
      if (idx > 0 && (splitAt === -1 || idx < splitAt)) {
        splitAt = idx;
        sepLength = sep.length;
      }
    }
    if (splitAt === -1) continue;
    const term = row.slice(0, splitAt).trim();
    const translation = row.slice(splitAt + sepLength).trim();
    if (!term || !translation) continue;
    entries.push({ term, translation });
  }
  return sanitizeGlossary(entries);
};

/** system 提示词注入块；空词表返回空串（调用方据此跳过拼接）。 */export const buildGlossaryPrompt = (entries: readonly GlossaryEntry[]): string => {
  if (entries.length === 0) return '';
  const pairs = entries.map((entry) => `"${entry.term}" => "${entry.translation}"`).join('; ');
  return 'Glossary (mandatory): when the following source terms appear, translate each exactly as specified, '
    + `overriding every other rule (including keeping proper nouns unchanged): ${pairs}.`;
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 拉丁/符号词（C++、.NET、F# 等）按「字母数字边界」替换（cat 不误伤 category、C++ 不误伤 C++11）；
 *  含 CJK 等其他字符的词无边界概念，退化为子串替换。 */
const isLatinTerm = (term: string): boolean => /^[A-Za-z0-9'’.:+#\-]+$/.test(term);

/**
 * MT 译文替换：对每条译文依词表顺序做全量替换。
 * 大小写不敏感（"kubernetes" 命中词表 "Kubernetes"）；替换发生在译文侧，
 * 命中即意味着 MT 未按固定译名输出（通常原样保留了原词）。
 */
export const applyGlossaryReplacements = (
  texts: readonly string[],
  entries: readonly GlossaryEntry[],
): string[] => {
  if (entries.length === 0) return [...texts];
  const rules = entries.map((entry) => ({
    pattern: isLatinTerm(entry.term)
      ? new RegExp(`(?<![0-9A-Za-z])${escapeRegExp(entry.term)}(?![0-9A-Za-z])`, 'gi')
      : new RegExp(escapeRegExp(entry.term), 'g'),
    translation: entry.translation,
  }));
  return texts.map((text) => {
    let result = text;
    for (const rule of rules) {
      result = result.replace(rule.pattern, rule.translation);
    }
    return result;
  });
};
