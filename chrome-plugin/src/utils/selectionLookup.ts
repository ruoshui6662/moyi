/**
 * 划词查词的纯逻辑层（无 DOM 依赖，便于单测）。
 *
 * 边界约定：
 * - 选区清洗：折叠空白；超长（> MAX_LOOKUP_CHARS）视为「整段误选」直接放弃自动弹卡，
 *   避免在长文里误触发起一次昂贵补全；
 * - 响应解析容错优先于格式洁癖：模型常把 JSON 包在 ```json 围栏里或前后带解释语，
 *   解析不出结构化结果时退化为「整段作为释义」，绝不让卡片空白；
 * - 所有字段过 sanitizeLookupResult 限长，防单次异常输出撑爆卡片。
 */

/** 选区上限：超过即判为整页级误选。
 *  2000 的来历（两次真机反馈校准）：200 太紧（3 行即超）；500 仍不够（多段落
 *  阅读选段常 600–1500 字）。2000 覆盖约 10 个自然段，同时仍挡住整页拖选；
 *  超限不再静默丢弃——卡片明示「选段过长」并给出缩小范围指引。 */
export const MAX_LOOKUP_CHARS = 2000;
/** 单词/短语判定的长度上限（含空格则必为短语）。 */
const WORD_MAX_CHARS = 24;

export type LookupKind = 'word' | 'phrase';

export interface LookupResult {
  /** 查询对象（清洗后的原词/原句）。 */
  term: string;
  /** 译文或对应说法。 */
  translation: string;
  /** 音标（词查询；短语为空）。 */
  phonetic: string;
  /** 词性（短语为空）。 */
  partOfSpeech: string;
  /** 释义 / 讲解（目标语言）。 */
  definition: string;
  /** 例句（可含译文）。 */
  example: string;
}

/** 折叠空白并清洗选区；空或超长返回 null。 */
export const normalizeSelectionText = (raw: string): string | null => {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  if (collapsed.length > MAX_LOOKUP_CHARS) return null;
  return collapsed;
};

/** 单词（单 token、够短）与短语/句段的分类，决定提示词形态。 */
export const classifyLookupKind = (text: string): LookupKind =>
  !text.includes(' ') && text.length <= WORD_MAX_CHARS ? 'word' : 'phrase';

/** 字段限长（结果模型统一走一遍，防异常输出撑爆卡片）。 */
const FIELD_MAX = 600;
const capField = (value: unknown): string => (typeof value === 'string' ? value.trim().slice(0, FIELD_MAX) : '');

export const sanitizeLookupResult = (value: Partial<Record<keyof LookupResult, unknown>>): LookupResult => ({
  term: capField(value.term),
  translation: capField(value.translation),
  phonetic: capField(value.phonetic),
  partOfSpeech: capField(value.partOfSpeech),
  definition: capField(value.definition),
  example: capField(value.example),
});

/** 请求模型输出 JSON 的系统提示词（查词卡契约）。 */
export const buildLookupSystemPrompt = (targetLanguage: string): string =>
  'You are a compact dictionary and translation assistant embedded in a browser reader. '
  + 'Answer using ONLY the facts the reader needs; no introductions, no disclaimers. '
  + `Explain in ${targetLanguage}. Reply with exactly one JSON object, no markdown fences, with string fields: `
  + 'term (the queried text), translation (its equivalent in the target language), '
  + 'phonetic (IPA if a single word, else empty), partOfSpeech (if a single word, else empty), '
  + 'definition (brief meaning or explanation), example (one short illustrative sentence, may include its translation). '
  + 'Use empty strings for fields that do not apply.';

export const buildLookupUserPrompt = (text: string, kind: LookupKind): string =>
  kind === 'word' ? `Query (single word): ${text}` : `Query (phrase or sentence): ${text}`;

/** 剥掉模型爱加的 markdown 代码围栏与前后杂语，截出第一个完整 JSON 对象。 */
export const extractJsonObject = (raw: string): string | null => {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenceMatch?.[1] ?? raw;
  const start = body.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
};

/**
 * 解析模型回复。结构化失败时退化为「原文 + 整段作为释义」——
 * 卡片宁可样式简陋也不给用户空白。
 */
export const parseLookupResponse = (queryText: string, raw: string): LookupResult => {
  const trimmed = raw.trim();
  const jsonText = extractJsonObject(trimmed);
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      const result = sanitizeLookupResult({
        term: typeof parsed.term === 'string' ? parsed.term : queryText,
        translation: parsed.translation,
        phonetic: parsed.phonetic,
        partOfSpeech: parsed.partOfSpeech,
        definition: parsed.definition,
        example: parsed.example,
      });
      if (result.term || result.translation || result.definition) {
        return { ...result, term: result.term || queryText };
      }
    } catch {
      // 落回兜底
    }
  }
  return sanitizeLookupResult({ term: queryText, definition: trimmed || '服务未返回可用释义。' });
};

// ── 阅读卡（Explain 深究态）：按语言水平讲解 + 卡片内追问 ──

export type ExplainLevel = 'beginner' | 'intermediate' | 'advanced';

export const EXPLAIN_LEVELS: readonly { id: ExplainLevel; label: string }[] = [
  { id: 'beginner', label: '入门' },
  { id: 'intermediate', label: '进阶' },
  { id: 'advanced', label: '母语' },
];

export const EXPLAIN_LEVEL_LABEL: Record<ExplainLevel, string> = {
  beginner: '初级学习者（尽量简单，避免术语）',
  intermediate: '中级学习者（解释关键语法点，适度展开）',
  advanced: '母语者（关注语域、细微差别与地道表达）',
};

export interface ExplainResult {
  /** 一句话总述。 */
  answer: string;
  /** 语法/结构拆解。 */
  grammar: string;
  /** 用法与词义辨析。 */
  usage: string;
  /** 易错点。 */
  pitfalls: string;
  /** 例句。 */
  example: string;
}

const capExplainField = (value: unknown): string =>
  (typeof value === 'string' ? value.trim() : '').slice(0, FIELD_MAX);

export const sanitizeExplainResult = (value: Partial<Record<keyof ExplainResult, unknown>>): ExplainResult => ({
  answer: capExplainField(value.answer),
  grammar: capExplainField(value.grammar),
  usage: capExplainField(value.usage),
  pitfalls: capExplainField(value.pitfalls),
  example: capExplainField(value.example),
});

export const sanitizeExplainLevel = (value: unknown): ExplainLevel =>
  EXPLAIN_LEVELS.some((level) => level.id === value) ? value as ExplainLevel : 'intermediate';

export const buildExplainSystemPrompt = (targetLanguage: string): string =>
  'You are a patient reading coach embedded in a browser reader. '
  + `Write all explanations in ${targetLanguage}; quote the source text verbatim when referring to it. `
  + 'Reply with exactly one JSON object, no markdown fences, with string fields: '
  + 'answer (one-paragraph gist), grammar (syntax/structure breakdown, empty if not applicable), '
  + 'usage (word choice and nuance), pitfalls (common mistakes, empty if none), example (one natural example sentence). '
  + 'Use empty strings for fields that do not apply.';

export const buildExplainUserPrompt = (text: string, level: ExplainLevel, context?: string): string => {
  const lines = [`Level: ${EXPLAIN_LEVEL_LABEL[sanitizeExplainLevel(level)]}.`, `Text: ${text}`];
  if (context?.trim()) lines.push(`Surrounding paragraph for context (do not explain it): ${context.trim()}`);
  lines.push('Explain this text.');
  return lines.join('\n');
};

/** 追问：会话历史拼进同一 system（隐私默认：仅内存，关卡即弃，background 不落盘）。 */
export const buildFollowupMessages = (
  systemPrompt: string,
  initialUser: string,
  history: readonly { role: 'user' | 'assistant'; content: string }[],
): { role: 'user' | 'assistant' | 'system'; content: string }[] => {
  const messages: { role: 'user' | 'assistant' | 'system'; content: string }[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: initialUser },
  ];
  for (const turn of history) {
    if (turn.content.trim()) messages.push({ role: turn.role, content: turn.content });
  }
  return messages;
};

export const FOLLOWUP_SYSTEM_SUFFIX =
  ' The user is asking a follow-up question about the text explained just before. '
  + 'Answer in the same language, concisely and concretely. '
  + 'Reply with exactly one JSON object: {"answer": "..."} (you may also include "example" and "pitfalls").';

export const parseExplainResponse = (raw: string): ExplainResult => {
  const trimmed = raw.trim();
  const jsonText = extractJsonObject(trimmed);
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      const result = sanitizeExplainResult({
        answer: parsed.answer,
        grammar: parsed.grammar,
        usage: parsed.usage,
        pitfalls: parsed.pitfalls,
        example: parsed.example,
      });
      if (result.answer || result.usage || result.grammar) return result;
    } catch {
      // 落回兜底
    }
  }
  return sanitizeExplainResult({ answer: trimmed || '服务未返回可用讲解。' });
};

// ── 悬停查词：光标位置 → 词边界（纯函数，测试覆盖边界）──

export interface HoverWord {
  word: string;
  /** 词在原文本中的起止偏移（用于把卡片锚到词上）。 */
  start: number;
  end: number;
}

const LATIN_WORD = /[A-Za-z0-9'’\-]/;
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;

/**
 * 取 offset 所在的词：拉丁文按词字符边界（词内空格、标点切断），CJK 按连续汉字串
 * （中文无词边界，取光标处连续的 1–8 字串；上限避免整段成「一个词」）。
 * 非词字符（空白/纯标点）返回 null。
 */
export const extractHoverWord = (text: string, offset: number): HoverWord | null => {
  if (!text) return null;
  const at = Math.max(0, Math.min(offset, text.length - 1));
  const probe = text[at];
  if (LATIN_WORD.test(probe)) {
    let start = at;
    let end = at + 1;
    while (start > 0 && LATIN_WORD.test(text[start - 1])) start -= 1;
    while (end < text.length && LATIN_WORD.test(text[end])) end += 1;
    // 纯数字（端口号、年份）或单字符无词条价值
    const word = text.slice(start, end);
    if (word.length < 2 || /^\d+$/.test(word)) return null;
    return { word, start, end };
    return { word: text.slice(start, end), start, end };
  }
  if (CJK.test(probe)) {
    let start = at;
    let end = at + 1;
    while (start > 0 && CJK.test(text[start - 1])) start -= 1;
    while (end < text.length && CJK.test(text[end])) end += 1;
    if (end - start > 8) {
      // 长句居中取 8 字，锚点落在中间
      const from = Math.min(start + Math.floor((end - start - 8) / 2), end - 8);
      return { word: text.slice(from, from + 8), start: from, end: from + 8 };
    }
    return { word: text.slice(start, end), start, end };
  }
  return null;
};
