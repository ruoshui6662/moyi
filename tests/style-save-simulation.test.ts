import { describe, expect, it } from 'vitest';

// 回归守卫：options 页保存链路曾是「控件快照用短键名(preset/color/fontSize)，
// 配置模型要长键名(translationStyle/…)」，对象展开合并不报类型错误却永远写不进去。
// 本文件用内存版 chrome.storage 完整复刻 写入 → 读回 → 三字段比对，键名必须与
// src/entrypoints/options/main.ts 的 readThemeFromControls 保持一致。
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
  DEFAULT_CONFIG,
  getConfig,
  sanitizeTranslationColor,
  sanitizeTranslationFontSize,
  sanitizeTranslationStylePreset,
  saveConfig,
  TRANSLATION_STYLE_PRESETS,
} from '../chrome-plugin/src/utils/config';

const readThemeFromControls = (presetValue: string | undefined, colorRaw: string, sizeRaw: string) => ({
  translationStyle: sanitizeTranslationStylePreset(presetValue),
  translationColor: sanitizeTranslationColor(colorRaw),
  translationFontSize: sanitizeTranslationFontSize(sizeRaw),
});

describe('simulated style save → read-back verification', () => {
  it('verification passes for every preset × color × size combination', async () => {
    const sizes = ['0.8', '0.92', '0.95', '1', '1.08', '1.15'];
    const colors = ['#3f4a56', '#000000', '#abcdef', '#123456'];
    for (const preset of TRANSLATION_STYLE_PRESETS) {
      for (const color of colors) {
        for (const size of sizes) {
          delete backing['personal-translator-config'];

          const theme = readThemeFromControls(preset, color, size);
          const config = await getConfig();
          await saveConfig({ ...config, ...theme });

          const verified = await getConfig();
          const mismatches: string[] = [];
          if (verified.translationStyle !== theme.translationStyle) {
            mismatches.push(`preset ${theme.translationStyle} -> ${verified.translationStyle}`);
          }
          if (verified.translationColor !== theme.translationColor) {
            mismatches.push(`color ${theme.translationColor} -> ${verified.translationColor}`);
          }
          if (verified.translationFontSize !== theme.translationFontSize) {
            mismatches.push(`fontSize ${theme.translationFontSize} -> ${verified.translationFontSize}`);
          }
          expect(mismatches, `${preset}/${color}/${size}: ${mismatches.join('; ')}`).toEqual([]);
        }
      }
    }
  });

  it('legacy stored configs (missing new fields) still verify correctly', async () => {
    backing['personal-translator-config'] = {
      endpoint: 'https://x/v1',
      apiKey: 'k',
      model: 'm',
      targetLanguage: '简体中文',
      disableReasoning: true,
    };
    const theme = readThemeFromControls('jade-line', '#223344', '1.05');
    const config = await getConfig();
    await saveConfig({ ...config, ...theme });
    const verified = await getConfig();
    expect(verified.translationStyle).toBe('jade-line');
    expect(verified.translationColor).toBe('#223344');
    expect(verified.translationFontSize).toBeCloseTo(1.05);
  });

  it('DEFAULT_CONFIG remains untouched by saves', async () => {
    const theme = readThemeFromControls('paper', '#111111', '1.2');
    await saveConfig({ ...(await getConfig()), ...theme });
    expect(DEFAULT_CONFIG.translationColor).toBe('#3f4a56');
    expect(DEFAULT_CONFIG.translationFontSize).toBe(0.92);
  });

  it('rejects short-key snapshots that caused the original save failure', async () => {
    // 复刻历史 bug 形态：短键名快照合并后，配置字段保持旧值 → 校验必须能发现不一致
    delete backing['personal-translator-config'];
    const badSnapshot = { preset: 'paper', color: '#111111', fontSize: 1.2 };
    await saveConfig({ ...(await getConfig()), ...badSnapshot } as Parameters<typeof saveConfig>[0]);
    const verified = await getConfig();
    expect(verified.translationStyle).not.toBe(badSnapshot.preset);
    expect(verified).toHaveProperty('translationStyle');
  });

  it('sanitizes out-of-range style values read back from storage', async () => {
    backing['personal-translator-config'] = {
      translationStyle: 'not-a-preset',
      translationColor: 'red',
      translationFontSize: 9,
    };
    const config = await getConfig();
    expect(config.translationStyle).toBe('ink-line');
    expect(config.translationColor).toBe('#3f4a56');
    expect(config.translationFontSize).toBe(1.15);

    delete backing['personal-translator-config'];
  });

  it('saveConfig clamps values before writing', async () => {
    const config = await getConfig();
    await saveConfig({
      ...config,
      translationStyle: 'bogus' as never,
      translationColor: 'rgb(1,2,3)',
      translationFontSize: 0.1,
    });
    const stored = backing['personal-translator-config'] as Record<string, unknown>;
    expect(stored.translationStyle).toBe('ink-line');
    expect(stored.translationColor).toBe('#3f4a56');
    expect(stored.translationFontSize).toBe(0.8);
  });
});
