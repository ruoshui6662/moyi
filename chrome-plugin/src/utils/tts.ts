/**
 * 朗读（TTS v1，插件独有）：系统 speechSynthesis 零依赖实现。
 *
 * 三层关注点（每层可独立测试）：
 * - 分句 `splitSentences`：中英混排标点切分，句末标点归属前句、引号/括号跟随；
 *   无标点长文本按长度兜底切块——TTS 引擎对超长串的断句质量差且界面无进度。
 * - 音色 `pickVoice`：按目标语言挑系统音色（精确 locale → 语言前缀 → 系统默认），
 *   找不到时返回 undefined 由引擎自行挑——降级永远可用，绝不报错阻塞朗读。
 * - 队列 `TtsQueue`：顺序播放 + 打断/去重（同文本重复触发只重启不叠加）；
 *   start 事件不可靠（部分 Chrome 版本不发），用 enqueue 立即 speak 兼容。
 *
 * 已知边界：speechSynthesis 无「预取」API；队列 speak 下一句即等价于预取，
 * Edge TTS（WS 鉴权）不在 v1 范围。
 */

export const TTS_TEXT_MAX_CHARS = 4000;
/** 无标点兜底切块长度（按朗读节奏定，中英通用）。 */
const FALLBACK_CHUNK_CHARS = 160;

const SENTENCE_END = /[.!?。！？…]+["'”’）)」』】]*\s*/g;

/** 分句：标点切分 + 引号归属 + 无标点长串兜底。返回非空句数组（保序）。 */
export const splitSentences = (text: string): string[] => {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const out: string[] = [];
  let cursor = 0;
  SENTENCE_END.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SENTENCE_END.exec(trimmed)) !== null) {
    // 句末标点后若紧跟引号/括号（已在正则尾部吃掉），一并归入前句
    const end = match.index + match[0].length;
    const sentence = trimmed.slice(cursor, end).trim();
    if (sentence) out.push(sentence);
    cursor = end;
  }
  const tail = trimmed.slice(cursor).trim();
  if (tail) out.push(tail);
  // 无标点长串（如导出粘贴的长段落）：按长度兜底切块
  const result: string[] = [];
  for (const sentence of out) {
    if (sentence.length <= FALLBACK_CHUNK_CHARS * 2) {
      result.push(sentence);
      continue;
    }
    for (let i = 0; i < sentence.length; i += FALLBACK_CHUNK_CHARS) {
      const piece = sentence.slice(i, i + FALLBACK_CHUNK_CHARS).trim();
      if (piece) result.push(piece);
    }
  }
  return result;
};

/** 语言探测：给音色匹配用。CJK 表意文字与假名/韩文分别走 zh/ja/ko。 */
export const detectSpeechLang = (text: string): string => {
  if (/[぀-ゟ゠-ヿ]/.test(text)) return 'ja';
  if (/[가-힯]/.test(text)) return 'ko';
  if (/[一-鿿]/.test(text)) return 'zh';
  return 'en';
};

export interface SpeechVoiceLike {
  lang: string;
  name: string;
  default?: boolean;
  localService?: boolean;
  voiceURI?: string;
}

/** 音色挑选：精确 locale（含地区）→ 语言前缀 → undefined（引擎兜底）。 */
export const pickVoice = <V extends SpeechVoiceLike>(voices: readonly V[], lang: string): V | undefined => {
  if (voices.length === 0) return undefined;
  const target = lang.trim().toLowerCase();
  const prefix = target.split(/[-_]/)[0];
  const normalize = (value: string): string => value.toLowerCase().replace('_', '-');
  return (
    voices.find((voice) => normalize(voice.lang) === target)
    ?? voices.find((voice) => normalize(voice.lang).split('-')[0] === prefix)
    ?? voices.find((voice) => voice.default)
    ?? voices[0]
  );
};

/** BCP-47 语言码形态（zh-CN / en / pt-BR）；设置项里是显示名（English/简体中文），不能直接喂引擎。 */
const BCP47 = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i;

/**
 * 语言码归一：合法 BCP-47 透传；显示名等非法值（"English"、"英语"）一律退回
 * 按文本探测——把显示名当 lang 喂给引擎会让 utterance 无声，且音色匹配落空。
 */
export const normalizeSpeechLang = (lang: string | undefined, text: string): string => {
  const candidate = lang?.trim() ?? '';
  if (candidate && BCP47.test(candidate)) return candidate;
  return detectSpeechLang(text);
};

export interface TtsOptions {
  /** 目标语言（如「简体中文」/ 'en-US'）；留空则按文本内容探测。 */
  lang?: string;
  voiceURI?: string;
  rate?: number;
}

export interface TtsQueue {
  speak(text: string, options?: TtsOptions): void;
  stop(): void;
  isSpeaking(): boolean;
}

/** 语音合成门面：环境不支持时全部降级为无操作（设置页照常展示提示）。 */
export const isTtsSupported = (): boolean => typeof globalThis.speechSynthesis !== 'undefined';

export const createTtsQueue = (): TtsQueue => {
  /** 当前链的代际标记：stop() 后旧链的 onend 到达时据此自裁，绝不复活。 */
  let generation = 0;
  let currentText = '';

  const stop = (): void => {
    generation += 1;
    currentText = '';
    try {
      globalThis.speechSynthesis?.cancel();
    } catch {
      // 合成器已被页面其他代码移除：降级静默
    }
  };

  return {
    speak(text, options = {}) {
      if (!isTtsSupported()) return;
      const trimmed = text.trim().slice(0, TTS_TEXT_MAX_CHARS);
      if (!trimmed) return;
      // 同文本重复触发：重启而非叠加（用户连点「朗读」应从第一句重放）
      if (currentText === trimmed) stop();
      const myGeneration = ++generation;
      const sentences = splitSentences(trimmed);
      const lang = normalizeSpeechLang(options.lang, sentences[0] ?? trimmed);
      const rate = Math.min(2, Math.max(0.5, options.rate ?? 1));
      currentText = trimmed;
      let index = 0;

      const next = (): void => {
        if (myGeneration !== generation || index >= sentences.length) {
          if (myGeneration === generation) currentText = '';
          return;
        }
        const utterance = new SpeechSynthesisUtterance(sentences[index]);
        index += 1;
        utterance.lang = lang;
        const voices = globalThis.speechSynthesis.getVoices();
        const voice = options.voiceURI
          ? voices.find((item) => item.voiceURI === options.voiceURI)
          : pickVoice(voices, lang);
        if (voice) utterance.voice = voice;
        utterance.rate = rate;
        // onerror 同 onend 推进：单句被拒不卡死整链
        const advance = (): void => {
          if (myGeneration === generation) next();
        };
        utterance.onend = advance;
        utterance.onerror = advance;
        try {
          globalThis.speechSynthesis.speak(utterance);
        } catch {
          currentText = '';
        }
      };
      next();
    },
    stop,
    isSpeaking: () => isTtsSupported() && globalThis.speechSynthesis.speaking,
  };
};

/**
 * 目标语言显示名 → BCP-47 语音码。
 * 设置里存的是显示名（「简体中文」「英语」），直接喂引擎匹配不到音色、语种判定
 * 会在不同卡片间摇摆（译文/释义/原词各触发一次文本探测）。这里把显示名固定映射
 * 到确定的语音码：译文与释义一律用**目标语言音色**朗读；只有回退读原词时才按内容探测。
 */
const TARGET_SPEECH_LANG: Record<string, string> = {
  '简体中文': 'zh-CN', '中文': 'zh-CN', '简体': 'zh-CN', '中文（简体）': 'zh-CN',
  '繁体中文': 'zh-TW', '繁体': 'zh-TW',
  '英语': 'en-US', '英文': 'en-US', '英语（美国）': 'en-US', '美式英语': 'en-US',
  '英语（英国）': 'en-GB', '英式英语': 'en-GB',
  '日语': 'ja-JP', '韩语': 'ko-KR', '法语': 'fr-FR', '德语': 'de-DE',
  '西班牙语': 'es-ES', '俄语': 'ru-RU', '意大利语': 'it-IT', '葡萄牙语': 'pt-PT',
  '泰语': 'th-TH', '越南语': 'vi-VN', '印尼语': 'id-ID', '阿拉伯语': 'ar-SA',
  '荷兰语': 'nl-NL', '波兰语': 'pl-PL', '土耳其语': 'tr-TR',
};

/** 返回目标语言的语音码；无法识别（未登记的显示名）返回 null，由调用方按文本内容探测。 */
export const resolveTargetSpeechLang = (display: string | undefined): string | null => {
  const value = display?.trim() ?? '';
  if (!value) return null;
  if (TARGET_SPEECH_LANG[value]) return TARGET_SPEECH_LANG[value];
  // 已登记的小写写法（zh-CN / en 等）直接放行
  return /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value) ? value : null;
};
