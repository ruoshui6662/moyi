import { describe, expect, it } from 'vitest';

import {
  assembleSentences,
  buildSubtitleUnits,
  getUnitLength,
  isCJKLanguageCode,
  SENTENCE_MAX_CHARS_CJK,
} from '../chrome-plugin/src/utils/subtitles/segmenter';
import {
  findCueAt,
  findCueAtWithHold,
  type SubtitleCue,
} from '../chrome-plugin/src/utils/subtitles/trackLoader';

const frag = (start: number, end: number, text: string): SubtitleCue => ({ start, end, text });

describe('语言与长度合同', () => {
  it('识别 CJK 系轨道语言', () => {
    for (const code of ['zh', 'zh-CN', 'ja', 'ko', 'th']) expect(isCJKLanguageCode(code)).toBe(true);
    for (const code of ['en', 'fr', 'de', 'es']) expect(isCJKLanguageCode(code)).toBe(false);
  });

  it('CJK 计字符、其余语言计词', () => {
    expect(getUnitLength('你好世界，再见。', true)).toBe(8);
    expect(getUnitLength('one two three  four', false)).toBe(4);
  });
});

describe('assembleSentences 句子装配', () => {
  it('终结标点（. ! ?）结束句子，西文以空格拼接', () => {
    const sentences = assembleSentences(
      [frag(0, 1000, 'Hello world.'), frag(1000, 2000, 'How are you?'), frag(2000, 3000, 'Fine thanks.')],
      'en',
    );
    expect(sentences.map((s) => s.map((f) => f.text.trim()).join(' '))).toEqual([
      'Hello world.',
      'How are you?',
      'Fine thanks.',
    ]);
  });

  it('逗号不再是硬边界：跨逗号碎片合并为同一句', () => {
    const sentences = assembleSentences([frag(0, 800, 'I like it,'), frag(900, 1800, 'but let us go')], 'en');
    expect(sentences).toHaveLength(1);
    expect(sentences[0].map((f) => f.text.trim()).join(' ')).toBe('I like it, but let us go');
  });

  it('间隔超过 1.5s 视为说话停顿，句子落盘', () => {
    const sentences = assembleSentences([frag(0, 500, 'one'), frag(2100, 2600, 'two')], 'en');
    expect(sentences).toHaveLength(2);
  });

  it('新片段以符号（[ ( ♪）开头时不并入当前句', () => {
    const sentences = assembleSentences([frag(0, 500, 'look'), frag(600, 1200, '(applause) here')], 'en');
    expect(sentences).toHaveLength(2);
  });

  it('安全上限强制开新句：无标点连跑不会无限增长', () => {
    const twentyFiveChars = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰';
    const sentences = assembleSentences(
      [frag(0, 1000, twentyFiveChars), frag(1000, 2000, twentyFiveChars), frag(2000, 3000, twentyFiveChars)],
      'zh',
    );
    // 前两段合并 50 字仍在上限内；第三段将超 60 字被拒，另起新句
    expect(sentences).toHaveLength(2);
    const totalFirst = sentences[0].reduce((sum, f) => sum + f.text.trim().length, 0);
    expect(totalFirst).toBeLessThanOrEqual(SENTENCE_MAX_CHARS_CJK);
  });
});

describe('buildSubtitleUnits 显示单元规划', () => {
  it('ASR 式无标点碎片重组为完整句，播放中任意时刻都能取到整句单元', () => {
    const fragments = [
      frag(0, 600, 'today'),
      frag(600, 1200, 'we'),
      frag(1200, 1800, 'will'),
      frag(1800, 2400, 'talk about'),
      frag(2400, 3200, 'translation.'),
      // 前句以终结标点收尾，构成独立展示单元
      frag(4500, 5300, 'Let us start!'),
    ];
    const units = buildSubtitleUnits(fragments, 'en');
    expect(units.map((unit) => unit.text)).toEqual(['today we will talk about translation.', 'Let us start!']);
    expect(findCueAt(units, 1500)?.text).toBe('today we will talk about translation.');
    expect(findCueAt(units, 3300)).toBeNull();
  });

  it('超长句超过兜底阈值才切分，且切在子句边界而不是词中', () => {
    const longSentence =
      'When we first started working on this project many years ago, '
      + 'we honestly believed that the underlying technology was simply not ready yet, '
      + 'but over time every single part of it improved dramatically.'; // 共 33 词 > 30 词兜底
    const fragments = [
      frag(0, 900, 'When we first started working on this project many years ago,'),
      frag(900, 1800, 'we honestly believed that the underlying technology was simply not ready yet,'),
      frag(1800, 2700, longSentence.slice(longSentence.lastIndexOf('but'))),
    ];
    const units = buildSubtitleUnits(fragments, 'en');
    expect(units.length).toBeGreaterThan(1);
    // 每个显示单元都以子句标点收尾或构成完整收尾句，不再出现半句截断
    for (const unit of units.slice(0, -1)) {
      expect(unit.text).toMatch(/[,.;:!?)」』]$/);
    }
    expect(units[units.length - 1].text.endsWith('.')).toBe(true);
    // 不丢字
    const joined = units.map((unit) => unit.text).join(' ');
    for (const word of ['project', 'technology', 'dramatically.']) {
      expect(joined).toContain(word);
    }
  });

  it('阈值内的带逗号长句保持整句不切（尽量整句原则）', () => {
    const sentence =
      'Although the initial experiments did not produce the results we had hoped for, '
      + 'the team continued refining their methods with remarkable patience.'; // 共 22 词 ≤ 30
    const units = buildSubtitleUnits([frag(0, 6000, sentence)], 'en');
    expect(units).toHaveLength(1);
    expect(units[0].text).toBe(sentence);
  });

  it('单条碎片内含多个句子时被原子化拆分为独立单元', () => {
    const units = buildSubtitleUnits(
      [frag(0, 4000, "It's great. And you know, it really works.")],
      'en',
    );
    expect(units.map((unit) => unit.text)).toEqual(["It's great.", 'And you know, it really works.']);
    // 时间按字符占比分配：两段先后有序且覆盖原跨度
    expect(units[0].start).toBe(0);
    expect(units[units.length - 1].end).toBe(4000);
  });

  it('相邻短句不因带宽吸收而粘连（严禁跨句合并）', () => {
    const fragments = [
      frag(0, 600, 'Hi there.'),
      frag(600, 1400, 'How are you?'),
    ];
    const units = buildSubtitleUnits(fragments, 'en');
    expect(units.map((unit) => unit.text)).toEqual(['Hi there.', 'How are you?']);
  });

  it('重组不丢字：所有输入文本内容都出现在输出中', () => {
    const fragments = [
      frag(0, 500, '春眠不觉晓，'),
      frag(500, 1000, '处处闻啼鸟。'),
      frag(1200, 1700, '夜来风雨声，'),
      frag(1700, 2200, '花落知多少。'),
    ];
    const output = buildSubtitleUnits(fragments, 'zh').map((unit) => unit.text).join('');
    for (const piece of ['春眠不觉晓，', '处处闻啼鸟。', '夜来风雨声，', '花落知多少。']) {
      expect(output).toContain(piece);
    }
  });

  it('单元时间跨度覆盖全部成员片段', () => {
    const units = buildSubtitleUnits([frag(0, 800, '你好'), frag(800, 1600, '世界'), frag(1600, 2400, '再见')], 'zh');
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ start: 0, end: 2400 });
  });
});

describe('findCueAtWithHold 间隙保持', () => {
  const cues = [
    frag(0, 2000, 'first'),
    frag(3000, 5000, 'second'),
  ];

  it('命中区间内正常返回', () => {
    expect(findCueAtWithHold(cues, 1000)?.text).toBe('first');
    expect(findCueAtWithHold(cues, 4000)?.text).toBe('second');
  });

  it('结束后 ≤800ms 的空隙沿用上一条', () => {
    expect(findCueAtWithHold(cues, 2600)?.text).toBe('first');
    expect(findCueAtWithHold(cues, 5700)?.text).toBe('second');
  });

  it('超出保持窗口返回 null', () => {
    expect(findCueAtWithHold(cues, 2900)).toBeNull();
    expect(findCueAtWithHold(cues, 6500)).toBeNull();
  });
});
