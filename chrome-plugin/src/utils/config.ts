import type { TranslationPromptStyle } from './prompts';
import { CUSTOM_PROVIDER_ID, resolveProviderSettings, sanitizeProviderId, sanitizeProviders, type ProviderSettings } from './providers';
import type { PageShortcuts } from './shortcuts';

export type { TranslationPromptStyle } from './prompts';
export type { ProviderSettings } from './providers';
export { CUSTOM_PROVIDER_ID } from './providers';

export type TranslationStylePreset = 'ink-line' | 'jade-line' | 'underline' | 'highlight' | 'plain' | 'replace';

export const TRANSLATION_STYLE_PRESETS: readonly TranslationStylePreset[] = [
  'ink-line',
  'jade-line',
  'underline',
  'highlight',
  'plain',
  'replace',
];

/** 译文字号倍率的唯一合同：与 Options 滑杆范围一致。 */
export const TRANSLATION_FONT_SCALE_MIN = 0.8;
export const TRANSLATION_FONT_SCALE_MAX = 1.15;
export const TRANSLATION_FONT_SCALE_STEP = 0.01;

/** 悬浮按钮外观的唯一合同：触控可用下限之上、尽量少遮挡。 */
export const FLOAT_SIZE_MIN = 26;
export const FLOAT_SIZE_MAX = 48;
export const FLOAT_SIZE_DEFAULT = 32;
export const FLOAT_OPACITY_MIN = 0.15;
export const FLOAT_OPACITY_MAX = 1;
export const FLOAT_OPACITY_DEFAULT = 0.9;

export interface TranslatorConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  targetLanguage: string;
  disableReasoning: boolean;
  translationStyle: TranslationStylePreset;
  translationColor: string;
  translationFontSize: number;
  /** 译文字体栈；空串 = 跟随原文字体，非空 = 用户指定（系统字体）。 */
  translationFontFamily: string;
  /** 译文行高倍率（相对译文字号）；0 = 跟随原文节奏。 */
  translationLineHeight: number;
  /** 译文字距（em，随字号缩放）；0 = 跟随原文字距。 */
  translationLetterSpacing: number;
  /** 悬浮按钮直径（px）：可点击性与遮挡度的权衡由用户裁决。 */
  floatSize: number;
  /** 悬浮按钮不透明度（0~1）：闲置时低调、交互时自动全显。 */
  floatOpacity: number;
  promptStyle: TranslationPromptStyle;
  useCustomPrompt: boolean;
  customPrompt: string;
  providerId: string;
  providers: Record<string, ProviderSettings>;
  /** 应用内快捷键（页面内 keydown 触发）；空串表示未启用。 */
  shortcuts: PageShortcuts;
}

export const DEFAULT_CONFIG: TranslatorConfig = {
  endpoint: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  targetLanguage: '简体中文',
  disableReasoning: true,
  translationStyle: 'ink-line',
  translationColor: '#3f4a56',
  translationFontSize: 0.92,
  translationFontFamily: '',
  translationLineHeight: 0,
  translationLetterSpacing: 0,
  floatSize: FLOAT_SIZE_DEFAULT,
  floatOpacity: FLOAT_OPACITY_DEFAULT,
  promptStyle: 'general',
  useCustomPrompt: false,
  customPrompt: '',
  providerId: 'openai',
  providers: {},
  shortcuts: { translate: '', restore: '' },
};

const STORAGE_KEY = 'personal-translator-config';

/** 仅接受形如 "Control+Shift+K" 的组合键字符串，否则置空。 */
export const sanitizeShortcut = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const parts = trimmed.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return '';
  const validModifiers = new Set(['Control', 'Meta', 'Alt', 'Shift']);
  const modifierCount = parts.filter((part) => validModifiers.has(part)).length;
  const main = parts.filter((part) => !validModifiers.has(part)).join('+');
  if (modifierCount === 0 || !main) return '';
  return parts.join('+');
};

/** 自定义提示词上限（与 UI textarea maxlength 一致），防存储被污染时无限放大 prompt。 */
const CUSTOM_PROMPT_MAX_LENGTH = 500;

const sanitizeCustomPrompt = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.slice(0, CUSTOM_PROMPT_MAX_LENGTH);
};

export const getConfig = async (): Promise<TranslatorConfig> => {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const merged: TranslatorConfig = {
    ...DEFAULT_CONFIG,
    ...(result[STORAGE_KEY] as Partial<TranslatorConfig> | undefined),
  };
  merged.translationStyle = sanitizeTranslationStylePreset(merged.translationStyle);
  merged.translationColor = sanitizeTranslationColor(merged.translationColor);
  merged.translationFontSize = sanitizeTranslationFontSize(merged.translationFontSize);
  merged.translationFontFamily = sanitizeTranslationFontFamily(merged.translationFontFamily);
  merged.translationLineHeight = sanitizeTranslationLineHeight(merged.translationLineHeight);
  merged.translationLetterSpacing = sanitizeTranslationLetterSpacing(merged.translationLetterSpacing);
  merged.floatSize = sanitizeFloatSize(merged.floatSize);
  merged.floatOpacity = sanitizeFloatOpacity(merged.floatOpacity);
  merged.customPrompt = sanitizeCustomPrompt(merged.customPrompt);
  merged.shortcuts = {
    translate: sanitizeShortcut(merged.shortcuts?.translate),
    restore: sanitizeShortcut(merged.shortcuts?.restore),
  };

  const providers = sanitizeProviders(merged.providers);
  let providerId = sanitizeProviderId(merged.providerId, providers);

  // 老配置迁移：已有顶层 Key 但无凭据表时，归入默认「自定义」服务商，保证现有翻译不中断
  if (Object.keys(providers).length === 0 && merged.apiKey.trim()) {
    providers[CUSTOM_PROVIDER_ID] = {
      apiKey: merged.apiKey,
      endpoint: merged.endpoint,
      model: merged.model,
    };
    providerId = CUSTOM_PROVIDER_ID;
  }

  merged.providers = providers;
  merged.providerId = providerId;
  // 单一事实来源：顶层 apiKey/endpoint/model 由激活服务商动态派生，
  // 不再作为独立副本持久化，杜绝"同一把 Key 在存储中出现两份"的泄露面与分叉。
  const runtime = resolveProviderSettings(merged, providerId);
  merged.apiKey = runtime.apiKey;
  merged.endpoint = runtime.endpoint;
  merged.model = runtime.model;
  return merged;
};

export const saveConfig = async (config: TranslatorConfig): Promise<void> => {
  const sanitized: TranslatorConfig = {
    ...config,
    translationStyle: sanitizeTranslationStylePreset(config.translationStyle),
    translationColor: sanitizeTranslationColor(config.translationColor),
    translationFontSize: sanitizeTranslationFontSize(config.translationFontSize),
    translationFontFamily: sanitizeTranslationFontFamily(config.translationFontFamily),
    translationLineHeight: sanitizeTranslationLineHeight(config.translationLineHeight),
    translationLetterSpacing: sanitizeTranslationLetterSpacing(config.translationLetterSpacing),
    floatSize: sanitizeFloatSize(config.floatSize),
    floatOpacity: sanitizeFloatOpacity(config.floatOpacity),
    customPrompt: sanitizeCustomPrompt(config.customPrompt),
    shortcuts: {
      translate: sanitizeShortcut(config.shortcuts?.translate),
      restore: sanitizeShortcut(config.shortcuts?.restore),
    },
  };
  const stored: Record<string, unknown> = { ...DEFAULT_CONFIG, ...sanitized };
  // 顶层 apiKey/endpoint/model 仅是由 providers[providerId] 派生的投影，不入库
  delete stored.apiKey;
  delete stored.endpoint;
  delete stored.model;
  await chrome.storage.local.set({ [STORAGE_KEY]: stored });
};

export const CONFIG_STORAGE_KEY = STORAGE_KEY;

export const sanitizeTranslationStylePreset = (value: unknown): TranslationStylePreset =>
  typeof value === 'string' && (TRANSLATION_STYLE_PRESETS as readonly string[]).includes(value)
    ? (value as TranslationStylePreset)
    : DEFAULT_CONFIG.translationStyle;

export const sanitizeTranslationFontSize = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_CONFIG.translationFontSize;
  return Math.min(TRANSLATION_FONT_SCALE_MAX, Math.max(TRANSLATION_FONT_SCALE_MIN, Math.round(parsed * 100) / 100));
};

export const sanitizeTranslationColor = (value: unknown): string =>
  typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.trim()) ? value.trim() : DEFAULT_CONFIG.translationColor;

/** 清洗译文字体：仅接受有限长度字符串，其余回退为空（跟随原文）。 */
export const sanitizeTranslationFontFamily = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length > 80) return trimmed.slice(0, 80);
  return trimmed;
};

/** 译文行高倍率合同：0 = 跟随原文（渲染时另有 1.3 下限）；显式值物理下限为 1.0 ——
 * CJK 字形占满 em 方块，倍率 <1.0 时行盒必然矮于字形、相邻行重叠（表现为乱码）。 */
export const TRANSLATION_LINE_HEIGHT_MAX = 2.5;

/**
 * 行距清洗：{0} ∪ [1.0, 2.5]。
 * 0 与负数统一归为「跟随原文」；(0, 1.0) 是 CJK 排版的物理非法区，
 * 一律钳到 1.0 —— 不允许保存任何必然导致行重叠的值。
 */
export const sanitizeTranslationLineHeight = (value: unknown): number => {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  if (parsed <= 0) return 0;
  return Math.min(TRANSLATION_LINE_HEIGHT_MAX, Math.max(1, Math.round(parsed * 100) / 100));
};

/** 译文字距（em）：0 = 跟随原文；其余 clamp 到 [-0.05, 0.3]。 */
export const sanitizeTranslationLetterSpacing = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(0.3, Math.max(-0.05, Math.round(parsed * 1000) / 1000));
};

/** 悬浮按钮直径：缺失回默认；数值钳制到 [26, 48] 整数像素。 */
export const sanitizeFloatSize = (value: unknown): number => {
  if (value === null || value === undefined || value === '') return FLOAT_SIZE_DEFAULT;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return FLOAT_SIZE_DEFAULT;
  return Math.min(FLOAT_SIZE_MAX, Math.max(FLOAT_SIZE_MIN, Math.round(parsed)));
};

/** 悬浮按钮不透明度：缺失回默认；数值钳制到 [0.15, 1]，两位小数。 */
export const sanitizeFloatOpacity = (value: unknown): number => {
  if (value === null || value === undefined || value === '') return FLOAT_OPACITY_DEFAULT;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return FLOAT_OPACITY_DEFAULT;
  return Math.min(FLOAT_OPACITY_MAX, Math.max(FLOAT_OPACITY_MIN, Math.round(parsed * 100) / 100));
};
