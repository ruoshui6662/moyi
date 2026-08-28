import { relativeLuminance } from '../utils/colorReadability';

/**
 * 排版快照与派生模型。
 *
 * 译文尺寸以「原文计算样式」为基线、用户设置只是倍率：
 *   - 译文实际字号 = 候选元素 computed font-size × 用户倍率
 *   - 译文行高     = 译文字号 × max(原文行高比, 1.3)
 *   - 原文→译文间距 = clamp(原文行高 × 0.25, 3px, 10px)
 *
 * 字号、行高、间距按每段候选分别计算，标题/正文/脚注层级自然保留，
 * 且间距不随用户调大字号而同步膨胀。
 */

/** 行高为 normal 时使用的估算比例（浏览器默认约 1.2）。 */
export const NORMAL_LINE_HEIGHT_RATIO = 1.2;

/** 译文最低行高比：中文/日文/韩文方块字需要一定的上下空间。 */
export const MIN_TRANSLATION_LINE_HEIGHT = 1.3;

/** 原文→译文间距：按原文行高的比例，并夹取到可读区间。 */
export const GAP_RATIO = 0.25;
export const GAP_MIN_PX = 3;
export const GAP_MAX_PX = 10;

export interface ElementTypography {
  /** computed font-size，单位 px。 */
  fontSizePx: number;
  /** 行高比：px 行高换算为比例；normal 按估算值。 */
  lineHeightRatio: number;
  fontFamily: string;
  fontWeight: string;
  fontStyle: string;
  letterSpacing: string;
  wordSpacing: string;
  whiteSpace: string;
  wordBreak: string;
  writingMode: string;
  direction: string;
  textAlign: string;
  /** 候选元素有效背景色的相对亮度（0 黑 ~ 1 白）；无法确定时为 null。 */
  bgLuminance: number | null;
}

export interface TranslationTypography {
  /** 译文实际字号（px），随用户倍率缩放。 */
  fontSizePx: number;
  /** 译文行高（px）。 */
  lineHeightPx: number;
  /** 原文最后一行到译文第一行的间距（px），不随译文字号膨胀。 */
  gapPx: number;
}

const toNumber = (value: string | null, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** 向上查找首个不透明背景色并返回相对亮度；全透明返回 null。 */
const resolveBackgroundLuminance = (element: HTMLElement): number | null => {
  if (typeof getComputedStyle !== 'function') return null;
  let current: HTMLElement | null = element;
  while (current) {
    const color = getComputedStyle(current).backgroundColor;
    const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(color);
    if (rgb) {
      const alphaMatch = /rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/i.exec(color);
      const alpha = alphaMatch ? Number(alphaMatch[1]) : 1;
      if (alpha > 0) {
        const value = { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
        return relativeLuminance(value);
      }
    }
    current = current.parentElement;
  }
  return null;
};

/**
 * 采集候选元素的排版快照。jsdom 中 getComputedStyle 返回空对象，
 * 此时全部回退为默认值，保证单元测试与降级环境可用。
 */
export const captureElementTypography = (element: HTMLElement): ElementTypography => {
  const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
  const fontSizePx = toNumber(style?.fontSize ?? null, 16);
  const rawLineHeight = style?.lineHeight ?? '';

  let lineHeightRatio = NORMAL_LINE_HEIGHT_RATIO;
  if (rawLineHeight && rawLineHeight !== 'normal') {
    if (rawLineHeight.endsWith('px')) {
      const lineHeightPx = toNumber(rawLineHeight, fontSizePx);
      if (lineHeightPx > 0) lineHeightRatio = lineHeightPx / fontSizePx;
    } else {
      const ratio = toNumber(rawLineHeight, NORMAL_LINE_HEIGHT_RATIO);
      if (ratio > 0) lineHeightRatio = ratio;
    }
  }

  return {
    fontSizePx,
    lineHeightRatio,
    fontFamily: style?.fontFamily ?? '',
    fontWeight: style?.fontWeight ?? '',
    fontStyle: style?.fontStyle ?? '',
    letterSpacing: style?.letterSpacing ?? '',
    wordSpacing: style?.wordSpacing ?? '',
    whiteSpace: style?.whiteSpace ?? '',
    wordBreak: style?.wordBreak ?? '',
    writingMode: style?.writingMode ?? '',
    direction: style?.direction ?? '',
    textAlign: style?.textAlign ?? '',
    bgLuminance: resolveBackgroundLuminance(element),
  };
};

/** 根据原文快照与用户倍率派生译文实际字号、行高与间距。 */
export const computeTranslationTypography = (
  snapshot: ElementTypography,
  fontScale: number,
): TranslationTypography => {
  const fontSizePx = Math.round(snapshot.fontSizePx * fontScale * 100) / 100;
  const lineHeightPx = Math.round(fontSizePx * Math.max(snapshot.lineHeightRatio, MIN_TRANSLATION_LINE_HEIGHT) * 100) / 100;
  const sourceLineHeightPx = Math.round(snapshot.fontSizePx * snapshot.lineHeightRatio * 100) / 100;
  const gapPx = Math.round(Math.min(GAP_MAX_PX, Math.max(GAP_MIN_PX, sourceLineHeightPx * GAP_RATIO)) * 100) / 100;
  return { fontSizePx, lineHeightPx, gapPx };
};

/** 把排版快照转成译文节点可用的内联样式契约（不含几何与装饰）。 */
export const toTranslationStyle = (snapshot: ElementTypography): Record<string, string> => {
  const style: Record<string, string> = {};
  if (snapshot.fontFamily) style.fontFamily = snapshot.fontFamily;
  if (snapshot.fontWeight) style.fontWeight = snapshot.fontWeight;
  if (snapshot.fontStyle) style.fontStyle = snapshot.fontStyle;
  if (snapshot.letterSpacing) style.letterSpacing = snapshot.letterSpacing;
  if (snapshot.wordSpacing) style.wordSpacing = snapshot.wordSpacing;
  if (snapshot.whiteSpace) style.whiteSpace = snapshot.whiteSpace;
  if (snapshot.wordBreak) style.wordBreak = snapshot.wordBreak;
  if (snapshot.writingMode) style.writingMode = snapshot.writingMode;
  if (snapshot.direction) style.direction = snapshot.direction;
  if (snapshot.textAlign) style.textAlign = snapshot.textAlign;
  return style;
};
