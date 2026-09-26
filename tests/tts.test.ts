import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TTS_TEXT_MAX_CHARS,
  createTtsQueue,
  detectSpeechLang,
  isTtsSupported,
  normalizeSpeechLang,
  resolveTargetSpeechLang,
  pickVoice,
  splitSentences,
  type SpeechVoiceLike,
} from '../chrome-plugin/src/utils/tts';

describe('splitSentences', () => {
  it('英文句号切分并把结尾引号归入前句', () => {
    expect(splitSentences('Hello world. How are you? "Fine!"')).toEqual(['Hello world.', 'How are you?', '"Fine!"']);
  });

  it('中文标点切分，逗号不分句', () => {
    expect(splitSentences('今天天气好，我们出去走走。明天呢？')).toEqual(['今天天气好，我们出去走走。', '明天呢？']);
  });

  it('省略号不制造空句', () => {
    expect(splitSentences('等等……我来了。')).toEqual(['等等……', '我来了。']);
  });

  it('空输入返回空数组', () => {
    expect(splitSentences('   ')).toEqual([]);
  });

  it('无标点长串按长度兜底切块', () => {
    const long = 'a'.repeat(500);
    const pieces = splitSentences(long);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.length <= 160)).toBe(true);
    expect(pieces.join('')).toBe(long);
  });
});

describe('detectSpeechLang', () => {
  it('中日韩与拉丁文各走各的码', () => {
    expect(detectSpeechLang('你好')).toBe('zh');
    expect(detectSpeechLang('こんにちは')).toBe('ja');
    expect(detectSpeechLang('안녕하세요')).toBe('ko');
    expect(detectSpeechLang('hello')).toBe('en');
  });
});

describe('pickVoice', () => {
  const voices: SpeechVoiceLike[] = [
    { lang: 'en-US', name: 'Ava', default: true },
    { lang: 'zh-CN', name: 'Tingting' },
    { lang: 'ja-JP', name: 'Kyoko' },
  ];

  it('精确 locale 优先，其次语言前缀', () => {
    expect(pickVoice(voices, 'zh-CN')?.name).toBe('Tingting');
    expect(pickVoice(voices, 'zh')?.name).toBe('Tingting');
  });

  it('找不到时回退系统默认，再回退首个', () => {
    expect(pickVoice(voices, 'fr-FR')?.name).toBe('Ava');
    expect(pickVoice([{ lang: 'de-DE', name: 'X' }, { lang: 'it-IT', name: 'Y' }], 'fr')?.name).toBe('X');
  });

  it('空列表返回 undefined（引擎兜底）', () => {
    expect(pickVoice([], 'zh')).toBeUndefined();
  });
});

describe('normalizeSpeechLang（显示名不是语言码）', () => {
  it('合法 BCP-47 透传', () => {
    expect(normalizeSpeechLang('zh-CN', '任意文本')).toBe('zh-CN');
    expect(normalizeSpeechLang('en', '你好')).toBe('en');
    expect(normalizeSpeechLang('pt-BR', 'olá')).toBe('pt-BR');
  });

  it('显示名/空值退回按文本探测（英文模式下朗读哑火的根因修复）', () => {
    expect(normalizeSpeechLang('English', 'Hello there')).toBe('en');
    expect(normalizeSpeechLang('英语', '这是一段中文')).toBe('zh');
    expect(normalizeSpeechLang('简体中文', 'Mixed text')).toBe('en');
    expect(normalizeSpeechLang(undefined, '안녕')).toBe('ko');
    expect(normalizeSpeechLang('', 'こんにちは')).toBe('ja');
  });
});

describe('createTtsQueue（mock speechSynthesis）', () => {
  const spoken: SpeechSynthesisUtterance[] = [];
  let cancel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    spoken.length = 0;
    cancel = vi.fn();
    vi.stubGlobal('SpeechSynthesisUtterance', class {
      lang = '';
      rate = 1;
      voice: unknown = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public text: string) {}
    });
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => [{ lang: 'zh-CN', name: 'Tingting', voiceURI: 'zh' }],
      speak: (utterance: SpeechSynthesisUtterance) => spoken.push(utterance),
      cancel,
      speaking: false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('逐句链式播放：onend 推进下一句，结束后清空', () => {
    const queue = createTtsQueue();
    queue.speak('第一句。第二句。');
    expect(spoken).toHaveLength(1);
    expect(spoken[0].text).toBe('第一句。');
    (spoken[0].onend as unknown as (() => void) | null)?.();
    expect(spoken).toHaveLength(2);
    expect(spoken[1].text).toBe('第二句。');
    (spoken[1].onend as unknown as (() => void) | null)?.();
    expect(spoken).toHaveLength(2);
  });

  it('stop 后旧链 onend 不再推进（不复活）', () => {
    const queue = createTtsQueue();
    queue.speak('第一句。第二句。');
    queue.stop();
    (spoken[0].onend as unknown as (() => void) | null)?.();
    expect(spoken).toHaveLength(1);
    expect(cancel).toHaveBeenCalled();
  });

  it('同文本重复触发是重启而非叠加', () => {
    const queue = createTtsQueue();
    queue.speak('重复文本。');
    queue.speak('重复文本。');
    // cancel + 重新 speak，第二句链未与第一句叠加
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(spoken).toHaveLength(2);
  });

  it('onerror 同 onend：单句被拒不卡死整链', () => {
    const queue = createTtsQueue();
    queue.speak('甲。乙。');
    (spoken[0].onerror as unknown as (() => void) | null)?.();
    expect(spoken[1]?.text).toBe('乙。');
  });

  it('环境不支持 speechSynthesis 时全部降级为无操作', () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('speechSynthesis', undefined);
    expect(isTtsSupported()).toBe(false);
    const queue = createTtsQueue();
    expect(() => queue.speak('任意文本。')).not.toThrow();
    expect(() => queue.stop()).not.toThrow();
  });

  it('超长文本截断到 TTS 上限', () => {
    const queue = createTtsQueue();
    queue.speak('a'.repeat(TTS_TEXT_MAX_CHARS + 500));
    expect(spoken[0].text.length).toBeLessThanOrEqual(TTS_TEXT_MAX_CHARS);
  });
});

describe('resolveTargetSpeechLang（显示名 → 语音码）', () => {
  it('常见目标语言映射到确定的 BCP-47 码', () => {
    expect(resolveTargetSpeechLang('简体中文')).toBe('zh-CN');
    expect(resolveTargetSpeechLang('繁体中文')).toBe('zh-TW');
    expect(resolveTargetSpeechLang('英语')).toBe('en-US');
    expect(resolveTargetSpeechLang('英语（英国）')).toBe('en-GB');
    expect(resolveTargetSpeechLang('日语')).toBe('ja-JP');
    expect(resolveTargetSpeechLang('韩语')).toBe('ko-KR');
    expect(resolveTargetSpeechLang('法语')).toBe('fr-FR');
  });

  it('已是语音码的原样放行；未登记显示名/空值返回 null（由内容探测兜底）', () => {
    expect(resolveTargetSpeechLang('zh-CN')).toBe('zh-CN');
    expect(resolveTargetSpeechLang('pt-BR')).toBe('pt-BR');
    expect(resolveTargetSpeechLang('克林贡语')).toBeNull();
    expect(resolveTargetSpeechLang('')).toBeNull();
    expect(resolveTargetSpeechLang(undefined)).toBeNull();
  });

  it('映射结果会覆盖文本探测：中文译文即使用中文音色（不随内容摇摆）', () => {
    const captured: SpeechSynthesisUtterance[] = [];
    vi.stubGlobal('SpeechSynthesisUtterance', class {
      lang = ''; rate = 1; voice: unknown = null;
      onend: (() => void) | null = null; onerror: (() => void) | null = null;
      constructor(public text: string) {}
    });
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => [{ lang: 'zh-CN', name: 'Tingting', voiceURI: 'zh' }, { lang: 'en-US', name: 'Ava', voiceURI: 'en' }],
      speak: (u: SpeechSynthesisUtterance) => captured.push(u), cancel: () => undefined, speaking: false,
    });
    // 目标语言=简体中文，读的文本是译文（中文）→ 语言固定为 zh-CN，不做内容探测
    createTtsQueue().speak('这是中文译文字幕', { lang: resolveTargetSpeechLang('简体中文') ?? undefined });
    expect(captured[0]?.lang).toBe('zh-CN');
    // 回退读英文原词且未给 lang → 按内容探测 en
    createTtsQueue().speak('Within hours of the announcement');
    expect(captured[1]?.lang).toBe('en');
    vi.unstubAllGlobals();
  });
});
