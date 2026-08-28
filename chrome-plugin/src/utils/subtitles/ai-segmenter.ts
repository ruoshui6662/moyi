/**
 * AI 字幕断句（方法与提示词结构学习自开源项目 read-frog / 陪读蛙的
 * ai-segmentation 实现，提示词为独立重写）：
 *
 *   词级碎片 JSON → LLM → 简化 VTT（毫秒时间戳 + 完整句）→ 解析回 SubtitleCue[]
 *
 * 分工：规则断句器（segmenter.ts）负责即时首屏与本模块失败时的兜底；
 * AI 结果经 planSentencesForDisplay 做显示带宽规划后替换规则单元。
 * 需要 OpenAI 兼容服务商；DeepL 无语言模型，自动落回规则路线。
 */

import type { SubtitleCue } from './trackLoader';
import { planSentencesForDisplay } from './segmenter';

/**
 * 断句系统提示词。关键工程点（均来自实测教训的固化）：
 * 1. 完整句定义 + 不完整子句的识别特征（条件/原因没结果、连接词结尾、念起来没完）；
 * 2. 时间戳提取算法写死：句首词 s → 句末词 e，并附 WRONG/CORRECT 对照，
 *    防止模型把下一句起点错接到上一句终点；
 * 3. 无遗漏保证：每条输入碎片必须恰好出现在一个 cue 里；
 * 4. 只输出 VTT，不解释。
 */
export const SEGMENTATION_SYSTEM_PROMPT = `You are a subtitle segmentation expert. Convert word-level or phrase-level subtitle fragments into sentence-based subtitles in simplified VTT format.

## Input
A JSON array of fragments: [{"s":1000,"e":1200,"t":"hello"},{"s":1200,"e":1500,"t":"world"}]
- s: start time in milliseconds, e: end time in milliseconds, t: text content

## Output format
Simplified VTT with millisecond timestamps:
WEBVTT
1000 --> 1500
Hello world.
2000 --> 3500
This is a sentence.

## Rules
1. Each cue must be a COMPLETE, standalone sentence expressing a full thought.
2. Never split at incomplete clauses. A clause that cannot stand alone MUST be merged into the sentence it belongs to. Signs of an incomplete clause: it sets up a condition, time, or reason without stating the result; it ends with a conjunction; it would sound unfinished if spoken alone. Example: "When Moses left Egypt" is INCOMPLETE.
3. Timestamp algorithm: for each sentence, use the "s" of its FIRST word as START and the "e" of its LAST word as END. Adjacent sentences may share a boundary timestamp — that is correct.
4. Add appropriate punctuation (. ? ! ,) from context and capitalize the first letter of each sentence. Keep the original language: do NOT translate.
5. No omission: every input fragment must appear in exactly one cue, in order.
6. Output ONLY the VTT content, no explanations.

## Critical example (timestamp alignment)
Input: [{"s":134200,"e":134760,"t":"Moses"},{"s":134760,"e":135160,"t":"had"},{"s":135160,"e":136160,"t":"died"},{"s":136160,"e":136270,"t":"I"},{"s":136280,"e":138160,"t":"thought the story was about him"}]
WRONG: second cue starts at 134200 (reusing the first sentence's start).
CORRECT:
134200 --> 136160
Moses had died.
136160 --> 138160
I thought the story was about him.`;

/** 单块碎片 JSON 的字符预算：控制单次请求体量，超出自动分块。 */
export const SEGMENT_CHUNK_CHARS = 20_000;

/** AI 输出相对输入的最低文本覆盖率（去标点符号后的字符数比）。 */
export const MIN_COVERAGE_RATIO = 0.8;

const fragmentEntryJson = (cue: SubtitleCue): string =>
  JSON.stringify([{ s: Math.round(cue.start), e: Math.round(cue.end), t: cue.text }]).slice(1, -1);

/** 碎片 → JSON 分块（按 SEGMENT_CHUNK_CHARS 预算切分，不丢任何碎片）。 */
export const chunkFragmentsToJson = (cues: SubtitleCue[]): string[] => {
  const chunks: string[] = [];
  let current: string[] = [];
  let length = 1;
  for (const cue of cues) {
    if (!cue.text.trim()) continue;
    const entry = fragmentEntryJson(cue);
    const extra = entry.length + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && length + extra > SEGMENT_CHUNK_CHARS) {
      chunks.push(`[${current.join(',')}]`);
      current = [];
      length = 1;
    }
    current.push(entry);
    length += extra;
  }
  if (current.length > 0) chunks.push(`[${current.join(',')}]`);
  return chunks;
};

const VTT_TIMESTAMP_RE = /^(\d+)\s*-->\s*(\d+)$/;

/** 解析简化 VTT（毫秒时间戳行 + 文本行），忽略 WEBVTT 头与无法解析的行。 */
export const parseSimplifiedVtt = (vtt: string): SubtitleCue[] => {
  const cues: SubtitleCue[] = [];
  const lines = vtt.split(/\r?\n/);
  let index = 0;
  // 跳过到首个时间戳行（含 WEBVTT 头与任何非时间戳行）
  while (index < lines.length && !VTT_TIMESTAMP_RE.test(lines[index].trim())) index += 1;

  while (index < lines.length) {
    const match = VTT_TIMESTAMP_RE.exec(lines[index].trim());
    if (!match) {
      index += 1;
      continue;
    }
    const start = Number.parseInt(match[1], 10);
    const end = Number.parseInt(match[2], 10);
    index += 1;
    // 文本行：收集到空行或下一个时间戳行为止
    const textLines: string[] = [];
    while (
      index < lines.length
      && lines[index].trim() !== ''
      && !VTT_TIMESTAMP_RE.test(lines[index].trim())
    ) {
      textLines.push(lines[index].trim());
      index += 1;
    }
    const text = textLines.join(' ').trim();
    if (text && Number.isFinite(start) && Number.isFinite(end) && end > start) {
      cues.push({ start, end, text });
    }
  }
  return cues;
};

/** 去除标点/空白后的正字序列：用于覆盖率与顺序无关的文本比对。 */
const letterSignature = (texts: string[]): string =>
  texts
    .map((text) => text.match(/[\p{L}\p{N}]/gu)?.join('') ?? '')
    .join('')
    .toLowerCase();

/**
 * 健全性守卫：输出为空、按时间排序、覆盖率不足（模型丢词/改写原文）时抛错，
 * 由调用方回退到规则断句。
 */
export const validateSegmentedCues = (input: SubtitleCue[], output: SubtitleCue[]): SubtitleCue[] => {
  if (output.length === 0) throw new Error('AI 断句返回空结果。');
  const sorted = [...output].sort((a, b) => a.start - b.start || a.end - b.end);
  const inputSize = letterSignature(input.map((cue) => cue.text)).length;
  const outputSize = letterSignature(sorted.map((cue) => cue.text)).length;
  const coverage = outputSize / Math.max(1, inputSize);
  if (coverage < MIN_COVERAGE_RATIO) {
    throw new Error(`AI 断句覆盖率不足（${Math.round(coverage * 100)}%）。`);
  }
  return sorted;
};

/** 内容脚本 → 后台：请求 AI 断句，返回通过守卫的时间轴句子。 */
export const requestAiSegmentedCues = async (cues: SubtitleCue[]): Promise<SubtitleCue[]> => {
  const jsonChunks = chunkFragmentsToJson(cues);
  const response = await chrome.runtime.sendMessage({
    type: 'segment-subtitles',
    jsonChunks,
  }) as { ok?: boolean; vtt?: string; unsupported?: boolean; error?: string } | undefined;
  if (response?.unsupported) throw new Error(response.error || '当前服务商不支持 AI 断句。');
  if (!response?.ok || typeof response.vtt !== 'string') {
    throw new Error(response?.error || 'AI 断句请求失败。');
  }
  return validateSegmentedCues(cues, parseSimplifiedVtt(response.vtt));
};

/**
 * 编排入口：原始碎片 → AI 断句 → 显示带宽规划。
 * 失败时抛错，由宿主静默保留规则断句结果。
 */
export const refineCuesWithAi = async (
  rawCues: SubtitleCue[],
  languageCode: string,
): Promise<SubtitleCue[]> => {
  const segmented = await requestAiSegmentedCues(rawCues);
  return planSentencesForDisplay(segmented, languageCode);
};
