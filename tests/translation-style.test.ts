import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRANSLATION_THEME,
  buildTranslationCss,
} from '../chrome-plugin/src/entrypoints/content/translationRenderer';
import {
  DEFAULT_CONFIG,
  TRANSLATION_STYLE_PRESETS,
  sanitizeTranslationColor,
  sanitizeTranslationFontFamily,
  sanitizeTranslationFontSize,
  sanitizeTranslationLetterSpacing,
  sanitizeTranslationLineHeight,
  sanitizeTranslationStylePreset,
} from '../chrome-plugin/src/utils/config';

describe('buildTranslationCss', () => {
  it('keeps stable class names and default ink-line look', () => {
    const css = buildTranslationCss(DEFAULT_TRANSLATION_THEME);
    expect(css).toContain('.personal-translator-translation');
    expect(css).toContain('.personal-translator-error');
    expect(css).toContain('color: #3f4a56');
    expect(css).toContain('box-sizing: border-box');
    expect(css).toContain('border-inline-start: 2px solid rgba(176, 58, 46, 0.3)');
  });

  it('jade-line preset uses a muted ink-blue inline-start rule', () => {
    const css = buildTranslationCss({ ...DEFAULT_TRANSLATION_THEME, preset: 'jade-line' });
    expect(css).toContain('border-inline-start: 2px solid rgba(63, 74, 86, 0.35)');
    expect(css).not.toContain('rgba(176, 58, 46');
  });

  it('underline preset uses a dashed block-end rule', () => {
    const css = buildTranslationCss({ ...DEFAULT_TRANSLATION_THEME, preset: 'underline' });
    expect(css).toContain('border-block-end: 1px dashed rgba(103, 135, 116, 0.55)');
    expect(css).not.toContain('border-inline-start');
  });

  it('highlight preset renders cool moon-white block', () => {
    const css = buildTranslationCss({ ...DEFAULT_TRANSLATION_THEME, preset: 'highlight' });
    expect(css).toContain('background: rgba(226, 238, 241, 0.9)');
  });

  it('replace preset carries no marker decoration and keeps original wrapper hidden', () => {
    const css = buildTranslationCss({ ...DEFAULT_TRANSLATION_THEME, preset: 'replace' });
    expect(css).toContain('.personal-translator-original');
    expect(css).toContain('display: none');
    expect(css).not.toContain('border-inline-start');
    expect(css).not.toContain('background:');
  });

  it('plain preset removes marker decorations', () => {
    const css = buildTranslationCss({ ...DEFAULT_TRANSLATION_THEME, preset: 'plain' });
    expect(css).not.toContain('border-left');
    expect(css).not.toContain('border-bottom');
    expect(css).not.toContain('background:');
  });

  it('interpolates custom color and font scale', () => {
    const css = buildTranslationCss({ preset: 'plain', color: '#123456', fontScale: 1.1, fontFamily: '', lineHeight: 0, letterSpacing: 0 });
    expect(css).toContain('color: #123456');
    expect(css).toContain('box-sizing: border-box');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('always includes fade-in animation and error styling', () => {
    const css = buildTranslationCss({ preset: 'highlight', color: '#000000', fontScale: 1, fontFamily: '', lineHeight: 0, letterSpacing: 0 });
    expect(css).toContain('@keyframes personal-translator-fade-in');
    expect(css).toContain('animation: personal-translator-fade-in');
    expect(css).toContain('color: #b03a2e');
  });

  it('uses logical properties for markers and drops physical axis animation', () => {
    const ink = buildTranslationCss({ preset: 'ink-line', color: '#3f4a56', fontScale: 0.92, fontFamily: '', lineHeight: 0, letterSpacing: 0 });
    expect(ink).toContain('border-inline-start');
    expect(ink).toContain('padding-inline-start');
    expect(ink).not.toContain('border-left');
    expect(ink).not.toContain('margin-top');

    const underline = buildTranslationCss({ preset: 'underline', color: '#3f4a56', fontScale: 0.92, fontFamily: '', lineHeight: 0, letterSpacing: 0 });
    expect(underline).toContain('border-block-end');
    expect(underline).toContain('padding-block-end');
    expect(underline).not.toContain('border-bottom');
    expect(underline).not.toContain('translateY');
  });
});

describe('style config sanitizers', () => {
  it('accepts every registered preset and falls back to ink-line', () => {
    for (const preset of TRANSLATION_STYLE_PRESETS) {
      expect(sanitizeTranslationStylePreset(preset)).toBe(preset);
    }
    expect(sanitizeTranslationStylePreset('unknown')).toBe('ink-line');
    expect(sanitizeTranslationStylePreset(undefined)).toBe('ink-line');
    // 已移除的 paper 预设回退默认，不产生非法状态
    expect(sanitizeTranslationStylePreset('paper')).toBe('ink-line');
    expect(TRANSLATION_STYLE_PRESETS).not.toContain('paper');
    expect(TRANSLATION_STYLE_PRESETS).toContain('replace');
  });

  it('clamps font scale into the UI contract range and rounds to 2 decimals', () => {
    expect(sanitizeTranslationFontSize(0.92)).toBe(0.92);
    expect(sanitizeTranslationFontSize('1.08')).toBeCloseTo(1.08);
    expect(sanitizeTranslationFontSize(0.1)).toBe(0.8);
    expect(sanitizeTranslationFontSize(9)).toBe(1.15);
    expect(sanitizeTranslationFontSize('abc')).toBe(0.92);
    expect(sanitizeTranslationFontSize('0.8')).toBe(0.8);
    expect(sanitizeTranslationFontSize('1.15')).toBe(1.15);
    expect(sanitizeTranslationFontSize(0.77)).toBe(0.8);
    expect(sanitizeTranslationFontSize(1.4)).toBe(1.15);
  });

  it('only accepts hex colors and falls back to default', () => {
    expect(sanitizeTranslationColor('#3f4a56')).toBe('#3f4a56');
    expect(sanitizeTranslationColor('red')).toBe('#3f4a56');
    expect(sanitizeTranslationColor(undefined)).toBe('#3f4a56');
  });

  it('sanitizes translation font family: trims, caps length, defaults to follow original', () => {
    expect(sanitizeTranslationFontFamily('  KaiTi  ')).toBe('KaiTi');
    expect(sanitizeTranslationFontFamily('')).toBe('');
    expect(sanitizeTranslationFontFamily(undefined)).toBe('');
    expect(sanitizeTranslationFontFamily(42)).toBe('');
    expect(sanitizeTranslationFontFamily('x'.repeat(200)).length).toBeLessThanOrEqual(80);
    // 空 = 跟随原文字体
    expect(sanitizeTranslationFontFamily('')).toBe(DEFAULT_CONFIG.translationFontFamily);
  });

  it('sanitizes line height ratio and letter spacing with follow-original zero', () => {
    expect(sanitizeTranslationLineHeight(0)).toBe(0);
    expect(sanitizeTranslationLineHeight('1.5')).toBe(1.5);
    expect(sanitizeTranslationLineHeight(9)).toBe(2.5);
    expect(sanitizeTranslationLineHeight(-1)).toBe(0);
    expect(sanitizeTranslationLineHeight(undefined)).toBe(0);

    // 物理下限：CJK 倍率 <1.0 行盒必然矮于字形（行重叠/乱码），一律钳到 1.0
    expect(sanitizeTranslationLineHeight(1)).toBe(1);
    expect(sanitizeTranslationLineHeight(0.99)).toBe(1);
    expect(sanitizeTranslationLineHeight(0.5)).toBe(1);
    expect(sanitizeTranslationLineHeight(0.05)).toBe(1);

    expect(sanitizeTranslationLetterSpacing(0)).toBe(0);
    expect(sanitizeTranslationLetterSpacing('0.02')).toBe(0.02);
    expect(sanitizeTranslationLetterSpacing(0.9)).toBe(0.3);
    expect(sanitizeTranslationLetterSpacing(-0.2)).toBe(-0.05);
    expect(sanitizeTranslationLetterSpacing('abc')).toBe(0);
  });
});
