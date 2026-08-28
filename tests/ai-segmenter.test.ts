import { describe, expect, it } from 'vitest';

import {
  SEGMENT_CHUNK_CHARS,
  SEGMENTATION_SYSTEM_PROMPT,
  chunkFragmentsToJson,
  parseSimplifiedVtt,
  validateSegmentedCues,
} from '../chrome-plugin/src/utils/subtitles/ai-segmenter';
import { planSentencesForDisplay } from '../chrome-plugin/src/utils/subtitles/segmenter';
import type { SubtitleCue } from '../chrome-plugin/src/utils/subtitles/trackLoader';

const cue = (start: number, end: number, text: string): SubtitleCue => ({ start, end, text });

describe('SEGMENTATION_SYSTEM_PROMPT', () => {
  it('包含完整句定义与不完整子句识别特征', () => {
    expect(SEGMENTATION_SYSTEM_PROMPT).toContain('COMPLETE');
    expect(SEGMENTATION_SYSTEM_PROMPT).toContain('incomplete');
  });

  it('包含时间戳提取算法与 WRONG/CORRECT 对照（防错接）', () => {
    expect(SEGMENTATION_SYSTEM_PROMPT).toContain('WRONG');
    expect(SEGMENTATION_SYSTEM_PROMPT).toContain('CORRECT');
    expect(SEGMENTATION_SYSTEM_PROMPT).toContain('134200');
  });

  it('明确要求不翻译原文', () => {
    expect(SEGMENTATION_SYSTEM_PROMPT).toContain('do NOT translate');
  });
});

describe('chunkFragmentsToJson', () => {
  it('少量碎片合并为单个 JSON 数组', () => {
    const chunks = chunkFragmentsToJson([cue(0, 500, 'hello'), cue(500, 1000, 'world')]);
    expect(chunks).toHaveLength(1);
    expect(JSON.parse(chunks[0])).toEqual([
      { s: 0, e: 500, t: 'hello' },
      { s: 500, e: 1000, t: 'world' },
    ]);
  });

  it('超预算碎片按字符切分为多块，不丢任何碎片', () => {
    const fragments: SubtitleCue[] = [];
    // 单条约 110 字符（20 词 + 编号）；230 条约 25k 字符，必然触发分块
    for (let i = 0; i < 230; i += 1) {
      fragments.push(cue(i * 1000, i * 1000 + 500, `${'word '.repeat(20)}${i}`));
    }
    const chunks = chunkFragmentsToJson(fragments);
    expect(chunks.length).toBeGreaterThan(1);
    // 还原：每个块解析后合并，碎片数应一致
    const restored = chunks.flatMap((chunk) => JSON.parse(chunk));
    expect(restored).toHaveLength(fragments.length);
    expect(restored.map((f: { t: string }) => f.t)).toEqual(fragments.map((f) => f.text));
  });

  it('空文本碎片被跳过', () => {
    const chunks = chunkFragmentsToJson([cue(0, 500, ''), cue(500, 1000, 'ok')]);
    expect(chunks).toHaveLength(1);
    expect(JSON.parse(chunks[0])).toHaveLength(1);
  });

  it('SEGMENT_CHUNK_CHARS 阈值合理', () => {
    expect(SEGMENT_CHUNK_CHARS).toBeLessThanOrEqual(20000);
    expect(SEGMENT_CHUNK_CHARS).toBeGreaterThanOrEqual(5000);
  });
});

describe('parseSimplifiedVtt', () => {
  it('解析标准简化 VTT（含 WEBVTT 头）', () => {
    const vtt = `WEBVTT\n\n1000 --> 1500\nHello world.\n\n2000 --> 3500\nThis is a sentence.`;
    const cues = parseSimplifiedVtt(vtt);
    expect(cues).toEqual([
      { start: 1000, end: 1500, text: 'Hello world.' },
      { start: 2000, end: 3500, text: 'This is a sentence.' },
    ]);
  });

  it('多行文本 cue 被空格拼接', () => {
    const vtt = `1000 --> 2000\nLine one\nLine two`;
    expect(parseSimplifiedVtt(vtt)[0].text).toBe('Line one Line two');
  });

  it('忽略无时间戳的脏头行', () => {
    const vtt = `garbage header\n1000 --> 2000\nGood`;
    const cues = parseSimplifiedVtt(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('Good');
  });

  it('空行分隔相邻 cue，末尾脏行被丢弃', () => {
    const vtt = `1000 --> 2000\nGood\n\nbad standalone`;
    const cues = parseSimplifiedVtt(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('Good');
  });

  it('end <= start 的条目被丢弃', () => {
    const vtt = `1000 --> 1000\nBad\n\n2000 --> 3000\nGood`;
    const cues = parseSimplifiedVtt(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('Good');
  });
});

describe('validateSegmentedCues', () => {
  it('覆盖充分且有序时通过，并按时间排序输出', () => {
    const input = [cue(0, 500, 'hello'), cue(500, 1000, 'world')];
    const output = [cue(500, 1000, 'world'), cue(0, 500, 'hello')];
    const result = validateSegmentedCues(input, output);
    expect(result[0].start).toBe(0);
    expect(result[1].start).toBe(500);
  });

  it('空结果抛错', () => {
    expect(() => validateSegmentedCues([cue(0, 500, 'hello')], [])).toThrow('空结果');
  });

  it('覆盖率不足时抛错', () => {
    const input = [cue(0, 500, 'a b c d e f g h')];
    const output = [cue(0, 500, 'a')]; // 仅 1/8 字母
    expect(() => validateSegmentedCues(input, output)).toThrow('覆盖率不足');
  });
});

describe('planSentencesForDisplay（AI 结果复用同一显示规划）', () => {
  it('整句输入 ≤ 阈值时保持原样', () => {
    const sentence = cue(0, 3000, 'This is a short sentence.');
    const units = planSentencesForDisplay([sentence], 'en');
    expect(units).toHaveLength(1);
    expect(units[0].text).toBe('This is a short sentence.');
  });

  it('超长句在子句边界（逗号）切分', () => {
    const long = cue(
      0,
      10000,
      'When we first started working on this project many years ago, '
        + 'we honestly believed that the underlying technology was simply not ready yet, '
        + 'but over time every single part of it improved dramatically.',
    );
    const units = planSentencesForDisplay([long], 'en');
    expect(units.length).toBeGreaterThan(1);
    expect(units[units.length - 1].text.endsWith('.')).toBe(true);
  });
});
