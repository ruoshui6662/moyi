/**
 * 字幕断句重组 v3（两阶段 + 原子化）：先「源语句子装配」，再「显示单元规划」。
 *
 * 第一性原则：单元必须语义自洽——能独立正确翻译的完整句/子句；
 * 显示带宽是第二位约束，超长句只允许在子句边界切分。
 *
 * 入口原子化：每个碎片先按内部标点爆开（时间按字符占比分配），
 * 使「单条 ASR 滚动窗口包含多句」「标点位于片段内部」的场景全部可见、可处理。
 *
 * 阶段一（句子装配）：只有真边界才落盘——
 *   终结标点（. ! ? … 及 CJK 等价物）/ 说话停顿 ≥ SENTENCE_PAUSE_TIMEOUT_MS /
 *   安全上限。逗号不再构成边界。
 *
 * 阶段二（显示规划）：句子 ≤ 硬切阈值 → 整句即单元（尽量整句）；
 *   超过兜底线才在评分最高的接缝切分（强标点 > 连接词开头 > 逗号顿号），
 *   切分后同句内做过短吸收，严禁跨句合并。
 */

import type { SubtitleCue } from './trackLoader';

/** 真句界终结标点：只有这些（或说话停顿）才结束一个句子。 */
export const SENTENCE_END_PATTERN = /[.!?…。！？；;\n]$/;

/** 相邻片段间隔超过该值视为说话停顿，句子落盘。 */
export const SEGMENT_PAUSE_TIMEOUT_MS = 1_500;

/** 句子装配安全上限：防无标点连跑无限增长（非 CJK 计词 / CJK 计字符）。 */
export const SENTENCE_MAX_WORDS_NON_CJK = 80;
export const SENTENCE_MAX_CHARS_CJK = 60;

/** 显示硬切阈值：句子超过该长度才做子句级切分（「实在无法整句」的兜底线）。 */
export const DISPLAY_MAX_WORDS_NON_CJK = 30;
export const DISPLAY_MAX_CHARS_CJK = 34;

/** 同句内过短显示片段的吸收下限。 */
export const DISPLAY_TARGET_MIN_NON_CJK = 8;
export const DISPLAY_TARGET_MIN_CJK = 10;

const CJK_LANGUAGE_PREFIXES = ['zh', 'ja', 'ko', 'th', 'lo', 'km', 'my'] as const;
const LEADING_SYMBOL_PATTERN = /^[[(【♪]/;

/**
 * 原子化切分正则：标点归属左侧_piece_。
 * 终结标点与子句标点一并爆开——装配阶段只认终结标点，逗号碎片会被重新合并，
 * 因此爆开不影响句子完整性；但显示规划的接缝评分从此能看见全部标点位置
 * （否则位于 YouTube 片段内部的标点是不可见的，导致退化成词中点硬切）。
 */
const CLAUSE_PIECE_RE = /[^,.!?…。！？；;：、]+[,.!?…。！？；;：、]*/g;

/**
 * 把单个碎片按其内部的标点爆开为原子片段：
 * 文本切成标点收尾的小片，时间在原 [start,end] 跨度内按字符占比线性分配。
 */
export const explodeFragment = (fragment: SubtitleCue): SubtitleCue[] => {
  const text = fragment.text.trim();
  if (!text) return [];
  const pieces = (text.match(CLAUSE_PIECE_RE) ?? [])
    .map((piece) => piece.trim())
    .filter(Boolean);
  if (pieces.length <= 1) return [{ ...fragment, text }];

  const totalChars = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const span = Math.max(fragment.end - fragment.start, 0);
  let cursor = fragment.start;
  return pieces.map((piece) => {
    const duration = span * (piece.length / totalChars);
    const cue: SubtitleCue = {
      start: Math.round(cursor),
      end: Math.round(cursor + duration),
      text: piece,
    };
    cursor += duration;
    return cue;
  });
};

export const isCJKLanguageCode = (languageCode: string): boolean =>
  CJK_LANGUAGE_PREFIXES.some((prefix) => languageCode.toLowerCase().startsWith(prefix));

/** 长度合同：CJK 计字符数，其余语言计空白分词数。 */
export const getUnitLength = (text: string, isCJK: boolean): number => {
  if (isCJK) return text.length;
  return text.split(/\s+/).filter(Boolean).length;
};

const joinTexts = (texts: string[], isCJK: boolean): string =>
  texts.join(isCJK ? '' : ' ').trim();

type FragmentGroup = SubtitleCue[];

const groupText = (group: FragmentGroup, isCJK: boolean): string =>
  joinTexts(group.map((frag) => frag.text.trim()), isCJK);

const groupLength = (group: FragmentGroup, isCJK: boolean): number =>
  getUnitLength(groupText(group, isCJK), isCJK);

// ── 阶段一：句子装配 ──

/**
 * 碎片 → 句子草稿。返回的每个分组是一个完整句，start/end 覆盖全部成员片段。
 * 入口先做原子化爆开：片段内部的句号/逗号变为可见接缝，
 * 使「单条 ASR 滚动窗口包含多句」的场景也能被正确拆分与切分。
 */
export const assembleSentences = (
  rawFragments: SubtitleCue[],
  languageCode: string,
): FragmentGroup[] => {
  const isCJK = isCJKLanguageCode(languageCode);
  const maxSentenceLength = isCJK ? SENTENCE_MAX_CHARS_CJK : SENTENCE_MAX_WORDS_NON_CJK;
  const fragments = rawFragments.flatMap((fragment) => explodeFragment(fragment));
  const sentences: FragmentGroup[] = [];
  let current: FragmentGroup | null = null;

  for (const fragment of fragments) {
    const text = fragment.text.trim();
    if (!text) continue;

    if (current === null) {
      current = [fragment];
      continue;
    }
    const previous = current[current.length - 1];
    const endsSentence = SENTENCE_END_PATTERN.test(previous.text.trim());
    const isSpeechPause = fragment.start - previous.end > SEGMENT_PAUSE_TIMEOUT_MS;
    const startsWithSymbol = LEADING_SYMBOL_PATTERN.test(text);
    const wouldExceedSafety =
      groupLength(current, isCJK) + getUnitLength(text, isCJK) > maxSentenceLength;

    if (endsSentence || isSpeechPause || startsWithSymbol || wouldExceedSafety) {
      sentences.push(current);
      current = [fragment];
      continue;
    }
    current.push(fragment);
  }
  if (current) sentences.push(current);
  return sentences.filter((sentence) => sentence.length > 0);
};

// ── 阶段二：显示单元规划 ──

/**
 * 片段接缝 k（左闭右开）的切分吸引力：
 * 3 = 左侧以强子句标点收尾（; :）；2 = 左侧以逗号/顿号收尾；
 * 2 = 右侧以从属连接词开头；0 = 无语言信号。
 */
const junctionScore = (leftGroup: FragmentGroup, rightGroup: FragmentGroup): number => {
  const leftEnds = leftGroup[leftGroup.length - 1].text.trim();
  if (/[;：;:]$/.test(leftEnds)) return 3;
  if (CONJ_START_RE.test(rightGroup[0].text.trim())) return 2;
  if (/[,，、]$/.test(leftEnds)) return 2;
  return 0;
};

const CONJ_START_RE =
  /^(?:and|but|or|so|yet|because|although|though|if|when|while|which|that|who|whom|whose|before|after|since|unless|whereas)\b/i;

/**
 * 把超长句递归切成 ≤ maxLen 的显示片段：
 * 每层在所有接缝里取「最高分中最靠近长度中点」的一个；完全无语言信号时
 * 以长度均衡的无信号接缝兜底（仅在病态无标点长句上发生）。
 */
const splitGroupToBand = (
  group: FragmentGroup,
  isCJK: boolean,
  maxLength: number,
): FragmentGroup[] => {
  if (groupLength(group, isCJK) <= maxLength || group.length < 2) return [group];

  const totalLength = groupLength(group, isCJK);
  let bestK = -1;
  let bestScore = 0;
  let bestBalance = Number.POSITIVE_INFINITY;
  for (let k = 1; k < group.length; k += 1) {
    const left = group.slice(0, k);
    const score = junctionScore(left, group.slice(k));
    const balance = Math.abs(groupLength(left, isCJK) - totalLength / 2);
    // 高分优先，同分取更均衡者；0 分接缝仅在没有任何候选时作兜底参与竞争
    if (score > bestScore || (score === bestScore && balance < bestBalance)) {
      bestScore = score;
      bestBalance = balance;
      bestK = k;
    }
  }
  if (bestK < 0) return [group];

  const left = splitGroupToBand(group.slice(0, bestK), isCJK, maxLength);
  const right = splitGroupToBand(group.slice(bestK), isCJK, maxLength);
  return [...left, ...right];
};

/** 同句内过短片段吸收：向前再向后，合计不超带宽上限。 */
const absorbShortPieces = (
  pieces: FragmentGroup[],
  isCJK: boolean,
  minLength: number,
  maxLength: number,
): FragmentGroup[] => {
  const merged = pieces.map((piece) => [...piece]);
  const lengthOf = (piece: FragmentGroup) => groupLength(piece, isCJK);
  const combine = (a: FragmentGroup, b: FragmentGroup): FragmentGroup => [...a, ...b];

  for (let i = 0; i < merged.length - 1;) {
    if (
      lengthOf(merged[i]) < minLength
      && lengthOf(combine(merged[i], merged[i + 1])) <= maxLength
    ) {
      merged.splice(i, 2, combine(merged[i], merged[i + 1]));
    } else {
      i += 1;
    }
  }
  for (let i = merged.length - 1; i > 0; i -= 1) {
    if (
      lengthOf(merged[i]) < minLength
      && lengthOf(combine(merged[i - 1], merged[i])) <= maxLength
    ) {
      merged.splice(i - 1, 2, combine(merged[i - 1], merged[i]));
    }
  }
  return merged;
};

/** 断句主入口：碎片 → 句子装配 → 显示切分 → 同句吸收。输出直接驱动调度与渲染。 */
export const buildSubtitleUnits = (
  fragments: SubtitleCue[],
  languageCode: string,
): SubtitleCue[] => {
  const sentences: SubtitleCue[] = assembleSentences(fragments, languageCode).map((group) => ({
    start: group[0].start,
    end: group.reduce((latest, frag) => Math.max(latest, frag.end), group[0].end),
    text: groupText(group, isCJKLanguageCode(languageCode)),
  }));
  return planSentencesForDisplay(sentences, languageCode);
};

/**
 * 显示单元规划：把「已断好的句子」（规则装配产物，或 AI 断句返回的完整句）
 * 按硬切阈值做子句级切分与同句吸收。AI 路线复用此函数，保证两条来源的
 * 显示粒度完全一致。
 */
export const planSentencesForDisplay = (
  sentences: SubtitleCue[],
  languageCode: string,
): SubtitleCue[] => {
  const isCJK = isCJKLanguageCode(languageCode);
  const displayMax = isCJK ? DISPLAY_MAX_CHARS_CJK : DISPLAY_MAX_WORDS_NON_CJK;
  const displayMin = isCJK ? DISPLAY_TARGET_MIN_CJK : DISPLAY_TARGET_MIN_NON_CJK;

  const units: SubtitleCue[] = [];
  for (const sentence of sentences) {
    const pieces = absorbShortPieces(
      splitGroupToBand(explodeFragment(sentence), isCJK, displayMax),
      isCJK,
      displayMin,
      displayMax,
    );
    for (const piece of pieces) {
      const text = groupText(piece, isCJK);
      if (!text) continue;
      units.push({
        start: piece[0].start,
        end: piece.reduce((latest, frag) => Math.max(latest, frag.end), piece[0].end),
        text,
      });
    }
  }
  return units.filter((unit) => unit.text.length > 0);
};
