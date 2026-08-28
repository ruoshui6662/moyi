import { describe, expect, it } from 'vitest';
import {
  GAP_MAX_PX,
  GAP_MIN_PX,
  MIN_TRANSLATION_LINE_HEIGHT,
  NORMAL_LINE_HEIGHT_RATIO,
  captureElementTypography,
  computeTranslationTypography,
  toTranslationStyle,
} from '../chrome-plugin/src/translation-core/typography';

const snapshot = (overrides: Partial<ReturnType<typeof captureElementTypography>> = {}) => ({
  fontSizePx: 16,
  lineHeightRatio: 1.5,
  fontFamily: '',
  fontWeight: '',
  fontStyle: '',
  letterSpacing: '',
  wordSpacing: '',
  whiteSpace: '',
  wordBreak: '',
  writingMode: '',
  direction: '',
  textAlign: '',
  bgLuminance: null,
  ...overrides,
});

describe('captureElementTypography', () => {
  it('falls back to defaults when computed style is unavailable', () => {
    const element = document.createElement('p');
    const typography = captureElementTypography(element);
    expect(typography.fontSizePx).toBe(16);
    expect(typography.lineHeightRatio).toBe(NORMAL_LINE_HEIGHT_RATIO);
    expect(typography.fontFamily).toBe('');
  });
});

describe('computeTranslationTypography', () => {
  it('scales font size by the user multiplier', () => {
    const result = computeTranslationTypography(snapshot({ fontSizePx: 16 }), 0.92);
    expect(result.fontSizePx).toBeCloseTo(14.72);
    expect(result.lineHeightPx).toBeCloseTo(22.08);
  });

  it('derives line height from source ratio with a readability floor', () => {
    const tight = computeTranslationTypography(snapshot({ fontSizePx: 32, lineHeightRatio: 1.09 }), 0.92);
    expect(tight.lineHeightPx).toBeCloseTo(32 * 0.92 * MIN_TRANSLATION_LINE_HEIGHT);
    expect(tight.lineHeightPx).toBeGreaterThan(32 * 0.92 * 1.09);
  });

  it('keeps gap stable when font scale grows (not tied to translation em)', () => {
    const small = computeTranslationTypography(snapshot({ fontSizePx: 16, lineHeightRatio: 1.5 }), 0.92);
    const large = computeTranslationTypography(snapshot({ fontSizePx: 16, lineHeightRatio: 1.5 }), 1.15);
    expect(large.gapPx).toBe(small.gapPx);
    expect(large.fontSizePx).toBeGreaterThan(small.fontSizePx);
  });

  it('clamps gap into the readable range', () => {
    const tiny = computeTranslationTypography(snapshot({ fontSizePx: 8, lineHeightRatio: 1.2 }), 1);
    expect(tiny.gapPx).toBe(GAP_MIN_PX);

    const huge = computeTranslationTypography(snapshot({ fontSizePx: 64, lineHeightRatio: 2 }), 1);
    expect(huge.gapPx).toBe(GAP_MAX_PX);
  });

  it('computes gap from source line height, not translation font size', () => {
    const a = computeTranslationTypography(snapshot({ fontSizePx: 16, lineHeightRatio: 1.2 }), 1);
    const b = computeTranslationTypography(snapshot({ fontSizePx: 16, lineHeightRatio: 1.8 }), 1);
    expect(b.gapPx).toBeGreaterThan(a.gapPx);
  });
});

describe('toTranslationStyle', () => {
  it('copies explicit typography contract properties', () => {
    const style = toTranslationStyle(snapshot({
      fontFamily: 'Georgia, serif',
      fontWeight: '700',
      fontStyle: 'italic',
      letterSpacing: '0.02em',
      wordSpacing: '0.1em',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      writingMode: 'horizontal-tb',
      direction: 'ltr',
      textAlign: 'left',
    }));
    expect(style.fontFamily).toBe('Georgia, serif');
    expect(style.fontWeight).toBe('700');
    expect(style.fontStyle).toBe('italic');
    expect(style.letterSpacing).toBe('0.02em');
    expect(style.wordSpacing).toBe('0.1em');
    expect(style.whiteSpace).toBe('pre-wrap');
    expect(style.wordBreak).toBe('break-word');
    expect(style.writingMode).toBe('horizontal-tb');
    expect(style.direction).toBe('ltr');
    expect(style.textAlign).toBe('left');
  });

  it('omits empty values to avoid redundant inline declarations', () => {
    const style = toTranslationStyle(snapshot());
    expect(Object.keys(style)).toHaveLength(0);
  });
});
