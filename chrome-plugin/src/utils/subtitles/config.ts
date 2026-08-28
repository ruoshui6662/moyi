/**
 * 字幕翻译配置：独立于主配置（utils/config.ts）的存储键与契约。
 * 仅被扩展侧引用（设置页 + YouTube 内容脚本）；油猴脚本不 import 本模块，
 * 因此本文件及其依赖的增删不会进入 userscript 构建产物。
 */

export type SubtitleDisplayMode = 'bilingual' | 'translation' | 'original';

export const SUBTITLE_DISPLAY_MODES: readonly SubtitleDisplayMode[] = [
  'bilingual',
  'translation',
  'original',
];

/** 译文字号（px）的唯一合同：与 Options 滑杆范围一致。 */
export const SUBTITLE_FONT_SIZE_MIN = 14;
export const SUBTITLE_FONT_SIZE_MAX = 36;

export interface SubtitleConfig {
  /** 总开关：开启后访问 YouTube/X 视频页自动加载并翻译字幕。 */
  enabled: boolean;
  /** X（Twitter）站点开关：总开关开启的前提下独立控制 x.com 的字幕翻译。 */
  xEnabled: boolean;
  /** AI 断句优化：用当前 OpenAI 兼容服务商重排句子边界（DeepL 自动跳过）。 */
  aiSegmentation: boolean;
  displayMode: SubtitleDisplayMode;
  /** 隐藏 YouTube 原生字幕，由插件统一样式绘制双语行。 */
  hideNativeCaptions: boolean;
  /** 译文文字颜色（#rrggbb）。 */
  color: string;
  /** 译文描边（边框）颜色（#rrggbb）；宽度随字号等比，不可独立调节。 */
  strokeColor: string;
  /** 译文字号（px）。 */
  fontSize: number;
  /** 译文阴影强度 [0,1]；0 = 无阴影。 */
  shadowIntensity: number;
  /** 译文字体栈（系统已装字体的 CSS font-family 写法）；空串 = 默认字幕字体栈。 */
  fontFamily: string;
}

export const DEFAULT_SUBTITLE_CONFIG: SubtitleConfig = {
  enabled: false,
  xEnabled: true,
  aiSegmentation: true,
  displayMode: 'bilingual',
  hideNativeCaptions: true,
  color: '#ffffff',
  strokeColor: '#000000',
  fontSize: 22,
  shadowIntensity: 0.6,
  fontFamily: '',
};

const STORAGE_KEY = 'moyi-subtitle-config';

/** 供内容脚本监听 chrome.storage.onChanged 使用。 */
export const SUBTITLE_CONFIG_STORAGE_KEY = STORAGE_KEY;

export const sanitizeSubtitleDisplayMode = (value: unknown): SubtitleDisplayMode =>
  typeof value === 'string' && (SUBTITLE_DISPLAY_MODES as readonly string[]).includes(value)
    ? (value as SubtitleDisplayMode)
    : DEFAULT_SUBTITLE_CONFIG.displayMode;

/** 仅接受形如 #rrggbb 的颜色，其余回退默认（与主配置 sanitizeTranslationColor 同规则）。 */
const sanitizeHexColor = (value: unknown, fallback: string): string =>
  typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.trim())
    ? value.trim()
    : fallback;

export const sanitizeSubtitleColor = (value: unknown): string =>
  sanitizeHexColor(value, DEFAULT_SUBTITLE_CONFIG.color);

export const sanitizeSubtitleStrokeColor = (value: unknown): string =>
  sanitizeHexColor(value, DEFAULT_SUBTITLE_CONFIG.strokeColor);

/** 译文字号：缺失回默认；数值钳制到 [MIN,MAX] 整数像素。 */
export const sanitizeSubtitleFontSize = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SUBTITLE_CONFIG.fontSize;
  return Math.min(
    SUBTITLE_FONT_SIZE_MAX,
    Math.max(SUBTITLE_FONT_SIZE_MIN, Math.round(parsed)),
  );
};

/** 阴影强度：缺失回默认；数值钳制到 [0,1]，两位小数。 */
export const sanitizeSubtitleShadow = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SUBTITLE_CONFIG.shadowIntensity;
  return Math.min(1, Math.max(0, Math.round(parsed * 100) / 100));
};

/** 清洗译文字体栈：仅接受有限长度字符串，其余回退为空（默认字幕字体栈）。 */
export const sanitizeSubtitleFontFamily = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length > 80) return trimmed.slice(0, 80);
  return trimmed;
};

export const getSubtitleConfig = async (): Promise<SubtitleConfig> => {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const merged: SubtitleConfig = {
    ...DEFAULT_SUBTITLE_CONFIG,
    ...(result[STORAGE_KEY] as Partial<SubtitleConfig> | undefined),
  };
  merged.displayMode = sanitizeSubtitleDisplayMode(merged.displayMode);
  merged.color = sanitizeSubtitleColor(merged.color);
  merged.strokeColor = sanitizeSubtitleStrokeColor(merged.strokeColor);
  merged.fontSize = sanitizeSubtitleFontSize(merged.fontSize);
  merged.shadowIntensity = sanitizeSubtitleShadow(merged.shadowIntensity);
  merged.fontFamily = sanitizeSubtitleFontFamily(merged.fontFamily);
  merged.enabled = merged.enabled === true;
  merged.xEnabled = merged.xEnabled !== false;
  merged.aiSegmentation = merged.aiSegmentation !== false;
  merged.hideNativeCaptions = merged.hideNativeCaptions !== false;
  return merged;
};

export const saveSubtitleConfig = async (config: SubtitleConfig): Promise<void> => {
  const sanitized: SubtitleConfig = {
    enabled: config.enabled === true,
    xEnabled: config.xEnabled !== false,
    aiSegmentation: config.aiSegmentation !== false,
    displayMode: sanitizeSubtitleDisplayMode(config.displayMode),
    hideNativeCaptions: config.hideNativeCaptions !== false,
    color: sanitizeSubtitleColor(config.color),
    strokeColor: sanitizeSubtitleStrokeColor(config.strokeColor),
    fontSize: sanitizeSubtitleFontSize(config.fontSize),
    shadowIntensity: sanitizeSubtitleShadow(config.shadowIntensity),
    fontFamily: sanitizeSubtitleFontFamily(config.fontFamily),
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: sanitized });
};
