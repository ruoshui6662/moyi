import { describe, expect, it } from 'vitest';
import {
  DARK_BG_LUMINANCE,
  TARGET_CONTRAST,
  contrastFromLuminance,
  contrastRatio,
  relativeLuminance,
  resolveReadableColor,
  type RgbColor,
} from '../chrome-plugin/src/utils/colorReadability';

const WHITE: RgbColor = { r: 255, g: 255, b: 255 };
const BLACK: RgbColor = { r: 0, g: 0, b: 0 };

describe('luminance & contrast', () => {
  it('computes WCAG relative luminance', () => {
    expect(relativeLuminance(BLACK)).toBe(0);
    expect(relativeLuminance(WHITE)).toBeCloseTo(1);
    expect(relativeLuminance({ r: 63, g: 74, b: 86 })).toBeGreaterThan(0);
  });

  it('computes contrast ratios with white/black bounds', () => {
    expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21);
    expect(contrastRatio(BLACK, BLACK)).toBeCloseTo(1);
    expect(contrastFromLuminance(1, 0)).toBeCloseTo(21);
  });
});

describe('resolveReadableColor', () => {
  it('keeps the user color on light backgrounds and when background is unknown', () => {
    expect(resolveReadableColor('#3f4a56', 0.9)).toBe('#3f4a56');
    expect(resolveReadableColor('#3f4a56', null)).toBe('#3f4a56');
    expect(resolveReadableColor('#3f4a56', undefined)).toBe('#3f4a56');
    expect(resolveReadableColor('not-a-color', 0.9)).toBe('not-a-color');
  });

  it('lightens dark user colors on dark backgrounds to a readable contrast', () => {
    const darkBg = 0.03; // 近黑背景
    const resolved = resolveReadableColor('#17171a', darkBg);
    expect(resolved.startsWith('#')).toBe(true);
    const rgb = {
      r: Number.parseInt(resolved.slice(1, 3), 16),
      g: Number.parseInt(resolved.slice(3, 5), 16),
      b: Number.parseInt(resolved.slice(5, 7), 16),
    };
    expect(contrastRatio(rgb, BLACK)).toBeGreaterThanOrEqual(TARGET_CONTRAST);
    // 提亮结果应明显比原色浅
    expect(relativeLuminance(rgb)).toBeGreaterThan(relativeLuminance({ r: 23, g: 23, b: 26 }));
  });

  it('keeps the default ink-blue color unchanged on light backgrounds', () => {
    expect(resolveReadableColor('#3f4a56', 0.9)).toBe('#3f4a56');
    const rgb = {
      r: Number.parseInt('#3f4a56'.slice(1, 3), 16),
      g: Number.parseInt('#3f4a56'.slice(3, 5), 16),
      b: Number.parseInt('#3f4a56'.slice(5, 7), 16),
    };
    expect(contrastRatio(rgb, WHITE)).toBeGreaterThan(3);
  });

  it('treats backgrounds below the dark threshold as dark', () => {
    expect(DARK_BG_LUMINANCE).toBeGreaterThan(0);
    expect(DARK_BG_LUMINANCE).toBeLessThan(0.5);
  });
});