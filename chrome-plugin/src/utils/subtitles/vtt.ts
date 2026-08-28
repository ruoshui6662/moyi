/**
 * X（Twitter）视频字幕源解析：HLS 清单中的字幕轨道 + WebVTT 正文。
 *
 * 数据链路：播放器经 hls.js 拉取 video.twimg.com 的 m3u8 主清单，
 * 原生字幕以 EXT-X-MEDIA:TYPE=SUBTITLES 轨道形式挂在主清单上；
 * 子清单列出 .vtt 分段，全部拉取即得完整 cue 列表——与 YouTube 的
 * json3 全量拉取同构，可直接接入既有断句/调度/渲染管线。
 *
 * 关键坑位：HLS WebVTT 分段头部带 X-TIMESTAMP-MAP
 * （LOCAL 时间 ↔ MPEGTS 90kHz 时钟），cue 实际时间需按
 * (mpegts/90000 − local) 偏移校正，否则整体漂移数秒。
 */

import type { SubtitleCue } from './trackLoader';
import { isNoiseText, joinSegs } from './trackLoader';

/** 主清单中一条字幕轨道（EXT-X-MEDIA TYPE=SUBTITLES）。 */
export interface HlsSubtitleRendition {
  /** 字幕媒体清单（segment list）绝对地址。 */
  url: string;
  languageCode: string;
  name?: string;
}

const SUBTITLES_LINE_RE = /^#EXT-X-MEDIA:(.+)$/;

/**
 * 解析 HLS 属性列表（KEY=VALUE 对，值可为带引号字符串，逗号在引号内不分割）。
 * 规格见 RFC 8216 §4.2。
 */
export const parseHlsAttributes = (line: string): Record<string, string> => {
  const attrs: Record<string, string> = {};
  let key = '';
  let buffer = '';
  let inQuotes = false;
  const flush = (): void => {
    if (key) attrs[key.trim()] = buffer.trim().replace(/^"|"$/g, '');
    key = '';
    buffer = '';
  };
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') inQuotes = false;
      else buffer += char;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === '=' && !key) {
      key = buffer;
      buffer = '';
      continue;
    }
    if (char === ',') {
      flush();
      continue;
    }
    buffer += char;
  }
  flush();
  return attrs;
};

/** 从主清单文本提取全部字幕轨道（URI 解析为绝对地址）。 */
export const parseHlsSubtitleRenditions = (masterText: string, masterUrl: string): HlsSubtitleRendition[] => {
  const renditions: HlsSubtitleRendition[] = [];
  for (const rawLine of masterText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('#EXT-X-MEDIA:')) continue;
    const match = SUBTITLES_LINE_RE.exec(line);
    if (!match) continue;
    const attrs = parseHlsAttributes(match[1]);
    if (!attrs.TYPE || attrs.TYPE.toUpperCase() !== 'SUBTITLES') continue;
    if (!attrs.URI) continue;
    try {
      renditions.push({
        url: new URL(attrs.URI, masterUrl).toString(),
        languageCode: attrs.LANGUAGE ?? '',
        name: attrs.NAME ?? undefined,
      });
    } catch {
      // 相对地址解析失败时跳过该轨道
    }
  }
  return renditions;
};

export type RenditionLangMatcher = (languageCode: string) => boolean;

/**
 * 字幕轨道选择：优先「非目标语言」的轨道；同语言轨道返回 null 由调用方提示无需翻译。
 * 多条候选时保持清单顺序（首个通常为默认轨）。
 */
export const selectRendition = (
  renditions: HlsSubtitleRendition[],
  isTargetLanguage: RenditionLangMatcher,
): HlsSubtitleRendition | null =>
  renditions.find((rendition) => rendition.languageCode !== '' && !isTargetLanguage(rendition.languageCode))
  ?? null;

/** 判断清单体是否为「字幕分段清单」（含 .vtt 分段引用）。 */
export const looksLikeVttSegmentList = (playlistText: string): boolean =>
  /\.vtt/i.test(playlistText);

/** 清单是否声明了非 NONE 加密（v1 不支持解密，明确报不支持）。 */
export const hasActiveEncryption = (playlistText: string): boolean =>
  /#EXT-X-KEY:(?!METHOD=NONE)/.test(playlistText);

/** 从字幕媒体清单提取全部分段的绝对地址（按顺序）。 */
export const extractVttSegmentUrls = (playlistText: string, playlistUrl: string): string[] => {
  const urls: string[] = [];
  for (const rawLine of playlistText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (!/\.vtt/i.test(line)) continue;
    try {
      urls.push(new URL(line, playlistUrl).toString());
    } catch {
      // 非法行跳过
    }
  }
  return urls;
};

/** X-TIMESTAMP-MAP 头的偏移量（毫秒）：mpegts 秒 − 本地秒。0 表示无偏移。 */
export const parseTimestampMapOffsetMs = (headerLines: string[]): number => {
  for (const line of headerLines) {
    // 规范写法为 X-TIMESTAMP-MAP=LOCAL:...,MPEGTS:...（等号分隔键值）
    const match = /^X-TIMESTAMP-MAP[=:]\s*LOCAL:([0-9:.]+)\s*,\s*MPEGTS:(\d+)/i.exec(line.trim());
    if (!match) continue;
    const localParts = match[1].split(':').map(Number);
    if (localParts.length !== 3 || localParts.some((n) => !Number.isFinite(n))) continue;
    const localSec = localParts[0] * 3600 + localParts[1] * 60 + localParts[2];
    const mpegtsSec = Number(match[2]) / 90_000;
    return Math.round((mpegtsSec - localSec) * 1000);
  }
  return 0;
};

const VTT_TIME_RE = /^(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})$/;

const parseVttTimestamp = (value: string): number | null => {
  const parts = value.trim().match(VTT_TIME_RE);
  if (!parts) return null;
  return Number(parts[1]) * 3_600_000 + Number(parts[2]) * 60_000 + Number(parts[3]) * 1_000 + Number(parts[4]);
};

/** 单个 vtt 分段的解析结果（含未对齐原始时间与映射偏移）。 */
export interface ParsedVttSegment {
  cues: SubtitleCue[];
}

/**
 * 解析单个 WebVTT 文本 → 未合并的 cue 列表（已应用 X-TIMESTAMP-MAP 偏移）。
 * 行内标签（<c>、<v 名字>、内联时间戳）剥除；多行拼接后收敛空白；
 * 纯噪声行（♪、[Music] 等）过滤。
 */
export const parseWebVtt = (vttText: string, offsetMs = 0): SubtitleCue[] => {
  const lines = vttText.split(/\r?\n/);
  const headerLines = lines.filter((line) => line.startsWith('X-TIMESTAMP-MAP'));
  const mappedOffset = offsetMs + parseTimestampMapOffsetMs(headerLines);

  const cues: SubtitleCue[] = [];
  let pendingStart = -1;
  let pendingEnd = -1;
  let textLines: string[] | null = null;

  const flushCue = (): void => {
    if (pendingStart < 0 || pendingEnd <= pendingStart || !textLines) {
      pendingStart = -1;
      pendingEnd = -1;
      textLines = null;
      return;
    }
    const text = joinSegs(
      textLines
        .join('\n')
        .replace(/<[^>]*>/g, '')
        .split('\n')
        .map((part) => ({ utf8: part })),
    );
    if (text && !isNoiseText(text)) {
      cues.push({ start: pendingStart + mappedOffset, end: pendingEnd + mappedOffset, text });
    }
    pendingStart = -1;
    pendingEnd = -1;
    textLines = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') {
      flushCue();
      continue;
    }
    if (line.startsWith('NOTE') || line.startsWith('STYLE') || line.startsWith('REGION')
      || line.startsWith('WEBVTT') || line.startsWith('X-TIMESTAMP-MAP')) continue;
    if (line.includes('-->') && !textLines) {
      const [from, to] = line.split('-->');
      const start = parseVttTimestamp(from);
      // 结束时间后可跟行内设置（如 line-align:start），取首个空白前的时间段
      const end = to ? parseVttTimestamp(to.trim().split(/\s+/)[0]) : null;
      if (start !== null && end !== null && end > start) {
        pendingStart = start;
        pendingEnd = end;
        textLines = [];
      }
      continue;
    }
    if (textLines) {
      // 提示标识行（纯数字 cue id）出现在时间轴之前，遇到时间轴会重置，这里自然忽略
      textLines.push(line);
    }
  }
  flushCue();
  return cues;
};

const MIN_CUE_DURATION_MS = 400;

/**
 * 多分段 cue 合并归一：按时间排序 → 相邻重复（分段边界续写）合并 →
 * 结束时间钳到下一条开始 → 保证最小展示时长。语义与 trackLoader 的
 * json3 收尾逻辑一致，保证下游断句器拿到同等规整度的输入。
 */
export const mergeVttCues = (rawCues: SubtitleCue[]): SubtitleCue[] => {
  const sorted = [...rawCues].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: SubtitleCue[] = [];
  for (const cue of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && cue.text === prev.text && cue.start <= prev.end + 50) {
      prev.end = Math.max(prev.end, cue.end);
      continue;
    }
    merged.push({ ...cue });
  }
  for (let i = 0; i < merged.length; i += 1) {
    const cue = merged[i];
    const nextStart = i + 1 < merged.length ? merged[i + 1].start : Number.POSITIVE_INFINITY;
    cue.end = Math.min(cue.end, nextStart);
    if (cue.end - cue.start < MIN_CUE_DURATION_MS) cue.end = cue.start + MIN_CUE_DURATION_MS;
  }
  return merged.filter((cue) => cue.text.trim().length > 0);
};
