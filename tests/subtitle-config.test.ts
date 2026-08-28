import { describe, expect, it } from 'vitest';

// 复刻 style-save-simulation 的内存版 chrome.storage，先于被测模块导入注入
const backing: Record<string, unknown> = {};
(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: async (key: string) => (key in backing ? { [key]: backing[key] } : {}),
      set: async (obj: Record<string, unknown>) => {
        Object.assign(backing, obj);
      },
    },
  },
};

import {
  DEFAULT_SUBTITLE_CONFIG,
  getSubtitleConfig,
  sanitizeSubtitleColor,
  sanitizeSubtitleDisplayMode,
  sanitizeSubtitleFontSize,
  sanitizeSubtitleFontFamily,
  sanitizeSubtitleShadow,
  sanitizeSubtitleStrokeColor,
  saveSubtitleConfig,
  SUBTITLE_CONFIG_STORAGE_KEY,
} from '../chrome-plugin/src/utils/subtitles/config';

describe('字幕配置清洗', () => {
  it('displayMode 仅接受三个合法值，其余回退双语', () => {
    expect(sanitizeSubtitleDisplayMode('translation')).toBe('translation');
    expect(sanitizeSubtitleDisplayMode('original')).toBe('original');
    expect(sanitizeSubtitleDisplayMode('bilingual')).toBe('bilingual');
    expect(sanitizeSubtitleDisplayMode('everything')).toBe(DEFAULT_SUBTITLE_CONFIG.displayMode);
    expect(sanitizeSubtitleDisplayMode(42)).toBe(DEFAULT_SUBTITLE_CONFIG.displayMode);
  });

  it('颜色仅接受 #rrggbb（译文颜色与描边同规则）', () => {
    expect(sanitizeSubtitleColor('#FFE28C')).toBe('#FFE28C');
    expect(sanitizeSubtitleColor(' #ffe28c ')).toBe('#ffe28c');
    expect(sanitizeSubtitleColor('red')).toBe(DEFAULT_SUBTITLE_CONFIG.color);
    expect(sanitizeSubtitleColor('#fff')).toBe(DEFAULT_SUBTITLE_CONFIG.color);
    expect(sanitizeSubtitleStrokeColor('#14284b')).toBe('#14284b');
    expect(sanitizeSubtitleStrokeColor(123)).toBe(DEFAULT_SUBTITLE_CONFIG.strokeColor);
  });

  it('字号钳制到 [14,36] 整数像素', () => {
    expect(sanitizeSubtitleFontSize(10)).toBe(14);
    expect(sanitizeSubtitleFontSize(99)).toBe(36);
    expect(sanitizeSubtitleFontSize(21.6)).toBe(22);
    expect(sanitizeSubtitleFontSize('not-a-number')).toBe(DEFAULT_SUBTITLE_CONFIG.fontSize);
  });

  it('阴影强度钳制到 [0,1] 两位小数', () => {
    expect(sanitizeSubtitleShadow(-1)).toBe(0);
    expect(sanitizeSubtitleShadow(2)).toBe(1);
    expect(sanitizeSubtitleShadow(0.345)).toBe(0.35);
    expect(sanitizeSubtitleShadow(undefined)).toBe(DEFAULT_SUBTITLE_CONFIG.shadowIntensity);
  });
});

describe('字幕配置存取（写 → 读回）', () => {
  it('保存后读回一致，非法字段在写入时被清洗', async () => {
    await saveSubtitleConfig({
      enabled: true,
      xEnabled: true,
      aiSegmentation: true,
      displayMode: 'translation',
      hideNativeCaptions: false,
      color: '#9fe6ff',
      strokeColor: '#14284b',
      fontSize: 30,
      shadowIntensity: 0.8,
      fontFamily: "'KaiTi', serif",
    });
    const loaded = await getSubtitleConfig();
    expect(loaded).toEqual({
      enabled: true,
      xEnabled: true,
      aiSegmentation: true,
      displayMode: 'translation',
      hideNativeCaptions: false,
      color: '#9fe6ff',
      strokeColor: '#14284b',
      fontSize: 30,
      shadowIntensity: 0.8,
      fontFamily: "'KaiTi', serif",
    });
  });

  it('字体栈清洗：超长截断、非法类型回空（默认字幕字体栈）', () => {
    expect(sanitizeSubtitleFontFamily('  得意黑  ')).toBe('得意黑');
    expect(sanitizeSubtitleFontFamily('x'.repeat(120))).toHaveLength(80);
    expect(sanitizeSubtitleFontFamily(42)).toBe('');
  });

  it('存储被污染时逐字段回退默认值而非崩溃', async () => {
    backing[SUBTITLE_CONFIG_STORAGE_KEY] = {
      enabled: 'yes',
      displayMode: 'hijacked',
      color: 'javascript:',
      fontSize: -5,
      shadowIntensity: 'high',
    };
    const loaded = await getSubtitleConfig();
    expect(loaded.enabled).toBe(false);
    expect(loaded.displayMode).toBe(DEFAULT_SUBTITLE_CONFIG.displayMode);
    expect(loaded.color).toBe(DEFAULT_SUBTITLE_CONFIG.color);
    // 有限数值走钳制（-5 → 下限 14），仅非有限数值才回退默认
    expect(loaded.fontSize).toBe(14);
    expect(loaded.shadowIntensity).toBe(DEFAULT_SUBTITLE_CONFIG.shadowIntensity);
    // 布尔契约：非 true 一律视为关闭；hideNativeCaptions 非 false 一律视为开启
    expect(loaded.hideNativeCaptions).toBe(true);
  });

  it('空存储返回完整默认配置', async () => {
    delete backing[SUBTITLE_CONFIG_STORAGE_KEY];
    expect(await getSubtitleConfig()).toEqual(DEFAULT_SUBTITLE_CONFIG);
  });
});
