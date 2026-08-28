/**
 * 字幕轨道获取与解析：
 * 1. 取轨选择（优先非目标语言的人工字幕，其次 ASR）；
 * 2. timedtext json3 → 归一化 cue 列表（含 ASR 滚动文本的基础归并、噪声过滤）；
 * 3. 请求 URL 拼装：fmt=json3 + 设备指纹 + 收割到的 pot/potc 风控令牌；
 * 4. 桥接不可用时的兜底：从当前页 HTML 提取 ytInitialPlayerResponse.captionTracks。
 */

import type { CaptionTrackInfo } from './protocol';

export interface SubtitleCue {
  /** 开始时间（毫秒）。 */
  start: number;
  /** 结束时间（毫秒）。 */
  end: number;
  text: string;
}

interface Json3Seg {
  utf8?: string;
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  /** 1 = 追加到前一个滚动窗口（ASR 字幕逐词滚出时的分隔标记）。 */
  aAppend?: number;
  segs?: Json3Seg[];
}

interface Json3Payload {
  events?: Json3Event[];
}

/** ASR 滚动窗口的最大累计长度：超出则截断开新 cue，避免单条无限增长。 */
const MAX_ROLLING_CHARS = 200;
/** 缺省时长与最小展示时长（毫秒）：json3 偶发缺 dDurationMs 或被钳到 0。 */
const DEFAULT_DURATION_MS = 1500;
const MIN_DURATION_MS = 400;

/** 纯噪声行：[Music]、（掌声）、♪…♪、纯符号等，不值得翻译。 */
export const isNoiseText = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return /^(?:\[[^\]]{0,24}\]|（[^（）]{0,24}）|\([^()]{0,24}\)|[♪♫🎵🎶~\-–—.\s…]+)$/i.test(trimmed);
};

/** segs 文本拼接：utf8 片段自带空格语义，直接连接后收敛空白。 */
export const joinSegs = (segs: Json3Seg[] | undefined): string => {
  if (!Array.isArray(segs)) return '';
  const raw = segs.map((seg) => seg.utf8 ?? '').join('');
  // CJK 相邻不留空格、拉丁词间保留单个空格：把所有空白折叠为单空格，
  // 再去掉 CJK 字符两侧的空格。
  return raw
    .replace(/\s+/g, ' ')
    .replace(/([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]) /g, '$1')
    .replace(/ ([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])/g, '$1')
    .trim();
};

/**
 * json3 events → cue 列表。
 * - 标准字幕：一个 event 一条 cue；
 * - ASR 滚动字幕：aAppend=1 的 event 是上一滚动窗口的增量，向当前条目追加，
 *   超过 MAX_ROLLING_CHARS 截断；结束时间在收尾阶段统一按「下一条开始」钳制，
 *   因此追加期间只推进 end 的临时值即可。
 */
export const parseJson3Events = (events: Json3Event[]): SubtitleCue[] => {
  const cues: SubtitleCue[] = [];
  for (const event of events) {
    const text = joinSegs(event.segs);
    if (!text || isNoiseText(text)) continue;
    const start = typeof event.tStartMs === 'number' && event.tStartMs >= 0 ? event.tStartMs : -1;
    if (start < 0) continue;
    const duration = typeof event.dDurationMs === 'number' && event.dDurationMs > 0 ? event.dDurationMs : DEFAULT_DURATION_MS;

    const last = cues[cues.length - 1];
    if (event.aAppend === 1 && last && start >= last.start && last.text.length + text.length <= MAX_ROLLING_CHARS) {
      const needsSpace = /[a-zA-Z0-9,!?;:]$/.test(last.text) && /^[a-zA-Z0-9']/.test(text);
      last.text = needsSpace ? `${last.text} ${text}` : last.text + text;
      last.end = Math.max(last.end, start + duration);
      continue;
    }
    cues.push({ start, end: start + duration, text });
  }

  // 收尾：相邻 cue 按开始时间排序后，结束时间钳到下一条开始（重叠消除），
  // 并保证最小展示时长；相邻同文合并（ASR 卡顿重发）。
  cues.sort((a, b) => a.start - b.start);
  const merged: SubtitleCue[] = [];
  for (const cue of cues) {
    const prev = merged[merged.length - 1];
    if (prev && prev.text === cue.text && cue.start <= prev.end + 50) {
      prev.end = Math.max(prev.end, cue.end);
      continue;
    }
    merged.push({ ...cue });
  }
  for (let i = 0; i < merged.length; i += 1) {
    const cue = merged[i];
    const nextStart = i + 1 < merged.length ? merged[i + 1].start : Number.POSITIVE_INFINITY;
    cue.end = Math.min(cue.end, nextStart);
    if (cue.end - cue.start < MIN_DURATION_MS) cue.end = cue.start + MIN_DURATION_MS;
  }
  return merged.filter((cue) => cue.text.trim().length > 0);
};

/** 解析 timedtext(json3) 响应体；结构非法时抛错。 */
export const parseJson3Payload = (payloadText: string): SubtitleCue[] => {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    throw new Error('字幕数据不是合法 JSON。');
  }
  const events = (payload as Json3Payload | null)?.events;
  if (!Array.isArray(events)) throw new Error('字幕数据缺少 events 字段。');
  const cues = parseJson3Events(events);
  if (cues.length === 0) throw new Error('字幕数据为空。');
  return cues;
};

export type TrackLangMatcher = (languageCode: string) => boolean;

/**
 * 取轨选择：优先「非目标语言的人工字幕」，其次「非目标语言的 ASR」。
 * 全部为目标语言（如视频本身就是中文而目标是中文）时返回 null，由调用方提示。
 */
export const selectTrack = (
  tracks: CaptionTrackInfo[],
  isTargetLanguage: TrackLangMatcher,
): CaptionTrackInfo | null => {
  const usable = tracks.filter((track) => typeof track.baseUrl === 'string' && track.baseUrl.includes('/api/timedtext'));
  const human = usable.filter((track) => track.kind !== 'asr');
  const foreignHuman = human.find((track) => !isTargetLanguage(track.languageCode));
  if (foreignHuman) return foreignHuman;
  const foreignAsr = usable.find((track) => track.kind === 'asr' && !isTargetLanguage(track.languageCode));
  if (foreignAsr) return foreignAsr;
  return null;
};

/** 从任意 timedtext URL 中提取 pot/potc 令牌参数。 */
export const extractPotFromUrl = (url: string): { pot?: string; potc?: string } => {
  try {
    const params = new URL(url, window.location.origin).searchParams;
    const pot = params.get('pot') ?? undefined;
    const potc = params.get('potc') ?? undefined;
    return { pot, potc };
  } catch {
    return {};
  }
};

export interface TimedtextUrlOptions {
  device?: Record<string, string> | null;
  cver?: string | null;
  pot?: string;
  potc?: string;
}

/** 设备指纹中会随请求复制的键（参考陪读蛙 url-builder 配方）。 */
const DEVICE_FINGERPRINT_KEYS = ['cbrand', 'cbr', 'cbrver', 'cos', 'cosver', 'cplatform'] as const;

/** 由轨道 baseUrl 拼装 json3 请求地址：固定参数配方 + 指纹 + 可选令牌。 */
export const buildTimedtextUrl = (baseUrl: string, options: TimedtextUrlOptions = {}): string => {
  // captionTracks.baseUrl 偶见 HTML 转义的分隔符，先还原再解析
  const url = new URL(baseUrl.replace(/&amp;/g, '&'), window.location.origin);
  const params = url.searchParams;
  params.set('fmt', 'json3');
  params.set('xorb', '2');
  params.set('xobt', '3');
  params.set('xovt', '3');
  params.set('c', 'WEB');
  params.set('cplayer', 'UNIPLAYER');
  if (options.cver) params.set('cver', options.cver);
  if (options.device) {
    for (const key of DEVICE_FINGERPRINT_KEYS) {
      const value = options.device[key];
      if (typeof value === 'string' && value) params.set(key, value);
    }
  }
  if (options.pot) params.set('pot', options.pot);
  if (options.potc) params.set('potc', options.potc);
  return url.toString();
};

/**
 * 依序尝试候选地址（带令牌的优先，最后是不带令牌的裸地址），返回首个成功解析的 cue 列表。
 * timedtext 在未授权时的典型表现是 HTTP 200 + 空响应体（而非 4xx），
 * 因此空响应单独识别并标注，避免误报成"数据损坏"。
 *
 * 突发限幅：最多尝试 2 个令牌候选 + 1 个裸地址，且候选之间留出间隔——
 * 短窗口内连发近似请求是典型爬虫特征，高频刷新场景下会加速触发边缘风控。
 */
export const fetchJson3Cues = async (
  track: CaptionTrackInfo,
  options: TimedtextUrlOptions & { potCandidates?: string[]; attemptGapMs?: number } = {},
): Promise<SubtitleCue[]> => {
  const { potCandidates = [], attemptGapMs = 250, ...base } = options;
  const tokenSets: { pot?: string; potc?: string }[] = [];
  for (const candidate of potCandidates) {
    const extracted = extractPotFromUrl(candidate);
    if ((extracted.pot || extracted.potc) && !tokenSets.some((set) => set.pot === extracted.pot && set.potc === extracted.potc)) {
      tokenSets.push(extracted);
    }
  }
  if (!tokenSets.some((set) => !set.pot && !set.potc)) tokenSets.push({});

  const potted = tokenSets.filter((set) => set.pot || set.potc).slice(0, 2);
  const bare = tokenSets.find((set) => !set.pot && !set.potc);
  const attempts: { pot?: string; potc?: string }[] = bare ? [...potted, bare] : potted;

  const failures: string[] = [];
  for (let index = 0; index < attempts.length; index += 1) {
    const tokens = attempts[index];
    if (index > 0 && attemptGapMs > 0) {
      await new Promise((resolve) => { window.setTimeout(resolve, attemptGapMs); });
    }
    const label = tokens.pot || tokens.potc ? `候选${index + 1}（带令牌）` : '裸地址（无令牌）';
    const url = buildTimedtextUrl(track.baseUrl, { ...base, ...tokens });
    try {
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.text();
      if (!body.trim()) throw new Error('200 空响应（疑似令牌无效被风控拦截）');
      return parseJson3Payload(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${label}→${message}`);
    }
  }
  throw new Error(`共尝试 ${failures.length} 个地址全部失败［${failures.join('；')}］`);
};

/** 从 html 中定位 marker 后的 JSON 数组文本（括号配对扫描，规避贪婪正则跨字段误配）。 */
const extractJsonArrayAfter = (html: string, marker: string): string | null => {
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const arrayStart = html.indexOf('[', start);
  if (arrayStart < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let arrayEnd = -1;
  for (let i = arrayStart; i < html.length && arrayEnd < 0; i += 1) {
    const char = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) arrayEnd = i;
    }
  }
  return arrayEnd < 0 ? null : html.slice(arrayStart, arrayEnd + 1);
};

const safeParseArray = (text: string | null): unknown[] | null => {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const normalizeRawTracks = (rawTracks: unknown[] | null): CaptionTrackInfo[] => {
  if (!rawTracks) return [];
  return rawTracks.flatMap((item: unknown): CaptionTrackInfo[] => {
    const track = item as {
      baseUrl?: string;
      languageCode?: string;
      kind?: string;
      vssId?: string;
      name?: { simpleText?: string; runs?: { text?: string }[] };
    };
    if (typeof track?.baseUrl !== 'string' || typeof track?.languageCode !== 'string') return [];
    return [{
      baseUrl: track.baseUrl,
      languageCode: track.languageCode,
      kind: typeof track.kind === 'string' ? track.kind : undefined,
      vssId: typeof track.vssId === 'string' ? track.vssId : undefined,
      name: track.name?.simpleText ?? track.name?.runs?.[0]?.text,
    }];
  });
};

export interface PageFallbackCaptionData {
  tracks: CaptionTrackInfo[];
  /** 音轨字幕地址（通常自带 pot/potc），供令牌候选使用。 */
  audioTrackUrls: string[];
}

/** 纯函数：从 watch 页 HTML 提取 captionTracks 与 audioTracks（ytInitialPlayerResponse 内嵌）。 */
export const extractCaptionDataFromHtml = (html: string): PageFallbackCaptionData => ({
  tracks: normalizeRawTracks(safeParseArray(extractJsonArrayAfter(html, '"captionTracks":'))),
  audioTrackUrls: (safeParseArray(extractJsonArrayAfter(html, '"audioTracks":')) ?? [])
    .flatMap((item: unknown): string[] => {
      const url = (item as { baseUrl?: unknown } | null)?.baseUrl;
      return typeof url === 'string' && url.includes('/api/timedtext') ? [url] : [];
    }),
});

/**
 * 兜底：桥接脚本不可用时，重新拉取当前 watch 页（同源自带 Cookie）
 * 提取轨道列表与音轨令牌地址。
 */
export const fetchPageFallbackCaptionData = async (): Promise<PageFallbackCaptionData> => {
  const response = await fetch(window.location.href, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`页面拉取失败（HTTP ${response.status}）。`);
  return extractCaptionDataFromHtml(await response.text());
};

/** 二分查找覆盖 tMs 的 cue；间隙返回 null。 */
export const findCueAt = (cues: SubtitleCue[], tMs: number): SubtitleCue | null => {
  if (cues.length === 0) return null;
  let low = 0;
  let high = cues.length - 1;
  let candidate = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cues[mid].start <= tMs) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (candidate < 0) return null;
  const cue = cues[candidate];
  return tMs < cue.end ? cue : null;
};

/** 字幕保持窗口：单元间短空隙沿用上一条内容，消除闪烁。 */
export const SUBTITLE_HOLD_MS = 800;

/**
 * 带「保持」的查找：命中失败时若仍处于上一条结束后的短空隙内，
 * 沿用上一条——字幕在句间停顿处不再黑屏跳变。
 */
export const findCueAtWithHold = (
  cues: SubtitleCue[],
  tMs: number,
  holdMs: number = SUBTITLE_HOLD_MS,
): SubtitleCue | null => {
  const hit = findCueAt(cues, tMs);
  if (hit) return hit;
  if (cues.length === 0 || holdMs <= 0) return null;

  let low = 0;
  let high = cues.length - 1;
  let candidate = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cues[mid].start <= tMs) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (candidate < 0) return null;
  return tMs - cues[candidate].end <= holdMs ? cues[candidate] : null;
};
