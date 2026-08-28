import {
  DEFAULT_CONFIG,
  getConfig,
  saveConfig,
  sanitizeTranslationColor,
  sanitizeTranslationFontFamily,
  sanitizeTranslationFontSize,
  sanitizeTranslationLetterSpacing,
  sanitizeTranslationLineHeight,
  sanitizeTranslationStylePreset,
} from '../../utils/config';
import { formatShortcut, validateShortcut, waitForKeyCombo } from '../../utils/shortcuts';
import { clearTranslationCache } from '../content/translationCache';
import type { TranslationStylePreset } from '../../utils/config';
import type { TranslationPromptStyle } from '../../utils/prompts';
import { sanitizePromptStyle } from '../../utils/prompts';
import {
  BUILT_IN_PROVIDERS,
  createCustomProviderId,
  getCustomProviderIds,
  getProviderDisplayName,
  getProviderMark,
  getProviderMeta,
  isCustomProviderId,
  isDeeplProviderId,
  isMtProviderId,
  isNoKeyMtProviderId,
  isProviderConfigured,
  resolveProviderSettings,
  type ProviderMeta,
  type ProviderSettings,
} from '../../utils/providers';
import { buildTranslationCss, toTranslationTheme, applyTranslationStyles } from '../content/translationRenderer';
import { beginTranslation } from '../content/translationState';
import { renderTranslation, restoreTranslation } from '../content/translationRenderer';
import { captureElementTypography } from '../../translation-core/typography';
import { logger } from '../../utils/logger';
import {
  DEFAULT_SUBTITLE_CONFIG,
  getSubtitleConfig,
  saveSubtitleConfig,
  sanitizeSubtitleColor,
  sanitizeSubtitleDisplayMode,
  sanitizeSubtitleFontSize,
  sanitizeSubtitleShadow,
  sanitizeSubtitleStrokeColor,
  type SubtitleConfig,
} from '../../utils/subtitles/config';
import { buildShadowCss, buildStrokeWidthPx } from '../../utils/subtitles/renderer';

const endpoint = document.querySelector<HTMLInputElement>('#endpoint')!;
const apiKey = document.querySelector<HTMLInputElement>('#apiKey')!;
const apiKeyLabel = document.querySelector<HTMLLabelElement>('#apiKeyLabel')!;
const model = document.querySelector<HTMLInputElement>('#model')!;
const disableReasoning = document.querySelector<HTMLInputElement>('#disableReasoning')!;
const serviceStatus = document.querySelector<HTMLDivElement>('#serviceStatus')!;
const builtinProviderList = document.querySelector<HTMLDivElement>('#builtinProviderList')!;
const mtProviderList = document.querySelector<HTMLDivElement>('#mtProviderList')!;
const customProviderList = document.querySelector<HTMLDivElement>('#customProviderList')!;
const providerLogo = document.querySelector<HTMLSpanElement>('#providerLogo')!;
const providerName = document.querySelector<HTMLHeadingElement>('#providerName')!;
const providerNameInput = document.querySelector<HTMLInputElement>('#providerNameInput')!;
const customNameField = document.querySelector<HTMLDivElement>('#customNameField')!;
const addCustomProviderButton = document.querySelector<HTMLButtonElement>('#addCustomProvider')!;
const deleteProviderButton = document.querySelector<HTMLButtonElement>('#deleteProvider')!;
const providerConfigured = document.querySelector<HTMLDivElement>('#providerConfigured')!;
const activeBadge = document.querySelector<HTMLSpanElement>('#activeBadge')!;
const fetchModelsButton = document.querySelector<HTMLButtonElement>('#fetchModels')!;
const modelSelect = document.querySelector<HTMLSelectElement>('#modelSelect')!;
const manualModelButton = document.querySelector<HTMLButtonElement>('#manualModel')!;
const modelField = document.querySelector<HTMLDivElement>('#modelField')!;
const disableReasoningRow = document.querySelector<HTMLDivElement>('#disableReasoningRow')!;
const deeplPlanField = document.querySelector<HTMLDivElement>('#deeplPlanField')!;
const deeplPlanSelect = document.querySelector<HTMLSelectElement>('#deeplPlan')!;
const apiSecret = document.querySelector<HTMLInputElement>('#apiSecret')!;
const region = document.querySelector<HTMLInputElement>('#region')!;
const tencentFields = document.querySelector<HTMLDivElement>('#tencentFields')!;
const serviceFields = document.querySelector<HTMLDivElement>('#serviceFields')!;
const microsoftHint = document.querySelector<HTMLParagraphElement>('#microsoftHint')!;
const googleHint = document.querySelector<HTMLParagraphElement>('#googleHint')!;
const presetInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="preset"]'));
const colorInput = document.querySelector<HTMLInputElement>('#translationColor')!;
const colorSwatches = Array.from(
  // 必须圈定容器：全局 [data-color] 会把字幕翻译区块的色板一并选中，
  // 导致点字幕色板误改「译文颜色」（历史上真实发生过的事故）
  document.querySelectorAll<HTMLButtonElement>('#translationColorSwatches [data-color]'),
);
const colorHex = document.querySelector<HTMLSpanElement>('#translationColorHex')!;
const fontSelectInput = document.querySelector<HTMLSelectElement>('#translationFontFamily')!;
const fontCustomInput = document.querySelector<HTMLInputElement>('#translationFontCustom')!;
const sizeInput = document.querySelector<HTMLInputElement>('#translationFontSize')!;
const sizeValue = document.querySelector<HTMLSpanElement>('#fontSizeValue')!;
const lineHeightInput = document.querySelector<HTMLInputElement>('#translationLineHeight')!;
const lineHeightValue = document.querySelector<HTMLSpanElement>('#lineHeightValue')!;
const letterSpacingInput = document.querySelector<HTMLInputElement>('#translationLetterSpacing')!;
const letterSpacingValue = document.querySelector<HTMLSpanElement>('#letterSpacingValue')!;
const previewH2 = document.querySelector<HTMLHeadingElement>('#previewH2')!;
const previewP = document.querySelector<HTMLParagraphElement>('#previewP')!;
const previewQuote = document.querySelector<HTMLQuoteElement>('#previewQuote')!;
const previewSamples: HTMLElement[] = [previewH2, previewP, previewQuote];
const styleStatus = document.querySelector<HTMLDivElement>('#styleStatus')!;
const openShortcutsButton = document.querySelector<HTMLButtonElement>('#openShortcuts')!;
const clearTranslateShortcutButton = document.querySelector<HTMLButtonElement>('#clearTranslateShortcut')!;
const translateShortcutDisplay = document.querySelector<HTMLElement>('#translateShortcutDisplay')!;
const clearRestoreShortcutButton = document.querySelector<HTMLButtonElement>('#clearRestoreShortcut')!;
const restoreShortcutDisplay = document.querySelector<HTMLElement>('#restoreShortcutDisplay')!;
const promptStyleInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="prompt-style"]'));
const useCustomPromptInput = document.querySelector<HTMLInputElement>('#useCustomPrompt')!;
const customPromptInput = document.querySelector<HTMLTextAreaElement>('#customPrompt')!;
const savePromptButton = document.querySelector<HTMLButtonElement>('#savePrompt')!;
const promptStatus = document.querySelector<HTMLDivElement>('#promptStatus')!;
const resetAllButton = document.querySelector<HTMLButtonElement>('#resetAll')!;
const openGuideButton = document.querySelector<HTMLButtonElement>('#openGuide')!;
const toggleKeyVisibilityButton = document.querySelector<HTMLButtonElement>('#toggleKeyVisibility')!;
const promptCharCount = document.querySelector<HTMLSpanElement>('#promptCharCount')!;
const toastHost = document.querySelector<HTMLDivElement>('#toastHost')!;
const confirmModal = document.querySelector<HTMLDivElement>('#confirmModal')!;
const modalCancelButton = document.querySelector<HTMLButtonElement>('#modalCancel')!;
const modalConfirmButton = document.querySelector<HTMLButtonElement>('#modalConfirm')!;
// ── 字幕翻译（独立配置契约，见 utils/subtitles/config.ts）──
const subtitleEnabledInput = document.querySelector<HTMLInputElement>('#subtitleEnabled')!;
const subtitleModeInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="subtitle-mode"]'));
const subtitleColorInput = document.querySelector<HTMLInputElement>('#subtitleColor')!;
const subtitleColorSwatches = Array.from(
  document.querySelectorAll<HTMLButtonElement>('#subtitleColorSwatches [data-color]'),
);
const subtitleColorHex = document.querySelector<HTMLSpanElement>('#subtitleColorHex')!;
const subtitleStrokeColorInput = document.querySelector<HTMLInputElement>('#subtitleStrokeColor')!;
const subtitleStrokeSwatches = Array.from(
  document.querySelectorAll<HTMLButtonElement>('#subtitleStrokeSwatches [data-color]'),
);
const subtitleStrokeColorHex = document.querySelector<HTMLSpanElement>('#subtitleStrokeColorHex')!;
const subtitleFontFamilySelect = document.querySelector<HTMLSelectElement>('#subtitleFontFamily')!;
const subtitleFontCustomInput = document.querySelector<HTMLInputElement>('#subtitleFontCustom')!;
const scanLocalFontsSubtitleButton = document.querySelector<HTMLButtonElement>('#scanLocalFontsSubtitle')!;
const scanLocalFontsStyleButton = document.querySelector<HTMLButtonElement>('#scanLocalFontsStyle')!;
const localFontOptionsList = document.querySelector<HTMLDataListElement>('#localFontOptions')!;
const subtitleFontSizeInput = document.querySelector<HTMLInputElement>('#subtitleFontSize')!;
const subtitleFontSizeValue = document.querySelector<HTMLSpanElement>('#subtitleFontSizeValue')!;
const subtitleShadowInput = document.querySelector<HTMLInputElement>('#subtitleShadow')!;
const subtitleShadowValue = document.querySelector<HTMLSpanElement>('#subtitleShadowValue')!;
const subtitleHideNativeInput = document.querySelector<HTMLInputElement>('#subtitleHideNative')!;
const subtitlePreview = document.querySelector<HTMLDivElement>('#subtitlePreview')!;
const subtitleStatus = document.querySelector<HTMLDivElement>('#subtitleStatus')!;
const resetSubtitleButton = document.querySelector<HTMLButtonElement>('#resetSubtitle')!;

type StatusTone = 'idle' | 'busy' | 'ok' | 'error';

const showToast = (message: string, tone: 'ok' | 'error' = 'ok'): void => {
  const toast = document.createElement('div');
  toast.className = `toast ${tone}`;
  toast.textContent = message;
  toastHost.appendChild(toast);
  window.setTimeout(() => {
    toast.classList.add('leaving');
    window.setTimeout(() => toast.remove(), 260);
  }, 2000);
};

const confirmDanger = (): Promise<boolean> =>
  new Promise((resolve) => {
    confirmModal.hidden = false;
    const close = (result: boolean): void => {
      confirmModal.hidden = true;
      modalCancelButton.removeEventListener('click', onCancel);
      modalConfirmButton.removeEventListener('click', onConfirm);
      resolve(result);
    };
    const onCancel = (): void => close(false);
    const onConfirm = (): void => close(true);
    modalCancelButton.addEventListener('click', onCancel);
    modalConfirmButton.addEventListener('click', onConfirm);
  });

const setStatus = (element: HTMLElement, message: string, tone: StatusTone = 'idle'): void => {
  element.textContent = message;
  element.classList.remove('ok', 'error', 'busy');
  if (tone !== 'idle') element.classList.add(tone);
};

interface ThemeSnapshot {
  translationStyle: TranslationStylePreset;
  translationColor: string;
  translationFontSize: number;
  translationFontFamily: string;
  translationLineHeight: number;
  translationLetterSpacing: number;
}

const previewStyle = document.createElement('style');
document.head.appendChild(previewStyle);

const PREVIEW_TRANSLATIONS: Record<string, string> = {
  previewH2: '墨迹在纸上轻轻流淌。',
  previewP: '墨迹在纸上轻轻流淌，承载着言语之外的意义。',
  previewQuote: '即便用你不懂的语言写下，文字依然承载分量。',
};

/** 从控件读取译文字体：预设栈 / 自定义输入 / 空（跟随原文）。 */
const readFontFamilyFromControls = (): string => {
  const selected = fontSelectInput.value;
  if (selected === '__custom__') return sanitizeTranslationFontFamily(fontCustomInput.value);
  return sanitizeTranslationFontFamily(selected);
};

const readThemeFromControls = (): ThemeSnapshot => ({
  translationStyle: sanitizeTranslationStylePreset(presetInputs.find((input) => input.checked)?.value),
  translationColor: sanitizeTranslationColor(colorInput.value),
  translationFontSize: sanitizeTranslationFontSize(sizeInput.value),
  translationFontFamily: readFontFamilyFromControls(),
  translationLineHeight: sanitizeTranslationLineHeight(lineHeightInput.value),
  translationLetterSpacing: sanitizeTranslationLetterSpacing(letterSpacingInput.value),
});

const themeEquals = (a: ThemeSnapshot, b: ThemeSnapshot): boolean =>
  a.translationStyle === b.translationStyle
  && a.translationColor === b.translationColor
  && a.translationFontSize === b.translationFontSize
  && a.translationFontFamily === b.translationFontFamily
  && a.translationLineHeight === b.translationLineHeight
  && a.translationLetterSpacing === b.translationLetterSpacing;

let previewInitialized = false;

const applyPreview = (): void => {
  const theme = readThemeFromControls();
  previewStyle.textContent = buildTranslationCss(toTranslationTheme(theme));
  applyTranslationStyles(toTranslationTheme(theme));
  if (!previewInitialized) {
    for (const sample of previewSamples) {
      const snapshot = captureElementTypography(sample);
      const state = beginTranslation(sample, sample.textContent ?? '', snapshot);
      renderTranslation(sample, PREVIEW_TRANSLATIONS[sample.id] ?? '译文', state.generation, snapshot);
    }
    previewInitialized = true;
  }
};

// ── 样式保存：双事件防抖自动保存 + 显式按钮 + 回读校验 ──
let lastSavedTheme: ThemeSnapshot | null = null;
let saveTimer: number | undefined;

const refreshDirtyHint = (): void => {
  if (!lastSavedTheme || styleStatus.classList.contains('error')) return;
  if (!themeEquals(readThemeFromControls(), lastSavedTheme)) {
    setStatus(styleStatus, '有未保存的修改…');
  } else {
    setStatus(styleStatus, '');
  }
};

const saveStyleNow = async (): Promise<void> => {
  window.clearTimeout(saveTimer);
  try {
    const theme = readThemeFromControls();
    const config = await getConfig();
    await saveConfig({ ...config, ...theme });

    const verified = await getConfig();
    if (
      verified.translationStyle !== theme.translationStyle ||
      verified.translationColor !== theme.translationColor ||
      verified.translationFontSize !== theme.translationFontSize ||
      verified.translationFontFamily !== theme.translationFontFamily ||
      verified.translationLineHeight !== theme.translationLineHeight ||
      verified.translationLetterSpacing !== theme.translationLetterSpacing
    ) {
      setStatus(styleStatus, '保存未生效，请重试或检查浏览器存储权限。', 'error');
      return;
    }

    lastSavedTheme = { ...theme };
    logger.info('options.style_save.success', { theme });
    showToast('样式已保存');
    setStatus(styleStatus, '样式已保存。', 'ok');
  } catch (error) {
    logger.error('options.style_save.failure', { error });
    showToast('保存失败', 'error');
    setStatus(styleStatus, error instanceof Error ? error.message : '样式保存失败。', 'error');
  }
};

const scheduleStyleSave = (): void => {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveStyleNow(), 400);
};

const syncSizeLabel = (): void => {
  const scale = sanitizeTranslationFontSize(sizeInput.value);
  const percent = Math.round(scale * 100);
  sizeValue.textContent = `${percent}%`;
  sizeInput.setAttribute('aria-valuetext', `${percent}%`);
  // 同步自绘滑块的填充段进度（WebKit 轨道渐变）
  const min = Number.parseFloat(sizeInput.min) || 0.8;
  const max = Number.parseFloat(sizeInput.max) || 1.15;
  const fill = Math.min(100, Math.max(0, ((scale - min) / (max - min)) * 100));
  sizeInput.style.setProperty('--range-fill', `${fill}%`);
};

/** 行距滑杆：0 = 跟随原文；>0 显示为倍率。 */
const syncLineHeight = (): void => {
  const value = sanitizeTranslationLineHeight(lineHeightInput.value);
  const label = value > 0 ? `${value.toFixed(2)}×` : '跟随原文';
  lineHeightValue.textContent = label;
  lineHeightInput.setAttribute('aria-valuetext', label);
  const min = Number.parseFloat(lineHeightInput.min) || 0;
  const max = Number.parseFloat(lineHeightInput.max) || 2;
  const fill = Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
  lineHeightInput.style.setProperty('--range-fill', `${fill}%`);
};

/** 字距滑杆（em）：0 = 跟随原文；非 0 显示带符号的 em 值。 */
const syncLetterSpacing = (): void => {
  const value = sanitizeTranslationLetterSpacing(letterSpacingInput.value);
  const formatted = value === 0 ? '跟随原文' : `${value > 0 ? '+' : ''}${value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}em`;
  letterSpacingValue.textContent = formatted;
  letterSpacingInput.setAttribute('aria-valuetext', formatted);
  const min = Number.parseFloat(letterSpacingInput.min) || -0.05;
  const max = Number.parseFloat(letterSpacingInput.max) || 0.3;
  const fill = Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
  letterSpacingInput.style.setProperty('--range-fill', `${fill}%`);
};

const syncColorControls = (): void => {
  const color = sanitizeTranslationColor(colorInput.value).toLowerCase();
  colorHex.textContent = color.toUpperCase();
  colorSwatches.forEach((swatch) => {
    swatch.setAttribute('aria-pressed', String(swatch.dataset.color === color));
  });
};

const handleStyleInput = (): void => {
  syncColorControls();
  syncSizeLabel();
  syncLineHeight();
  syncLetterSpacing();
  syncFontControls();
  applyPreview();
  refreshDirtyHint();
  scheduleStyleSave();
};

/** 字体控件联动：选择「自定义…」时显示输入框并聚焦。 */
const syncFontControls = (): void => {
  const isCustom = fontSelectInput.value === '__custom__';
  fontCustomInput.hidden = !isCustom;
  if (isCustom) fontCustomInput.focus();
};

presetInputs.forEach((input) => {
  input.addEventListener('input', handleStyleInput);
  input.addEventListener('change', handleStyleInput);
});
colorInput.addEventListener('input', handleStyleInput);
colorInput.addEventListener('change', handleStyleInput);
fontSelectInput.addEventListener('change', handleStyleInput);
fontCustomInput.addEventListener('input', handleStyleInput);
colorSwatches.forEach((swatch) => {
  swatch.addEventListener('click', () => {
    colorInput.value = sanitizeTranslationColor(swatch.dataset.color);
    handleStyleInput();
  });
});
sizeInput.addEventListener('input', handleStyleInput);
sizeInput.addEventListener('change', handleStyleInput);
// 行距物理下限磁性吸附：CJK 倍率 <1.0 必然行重叠，拖入非法区立即弹回 1.0
// （先于 handleStyleInput 注册，保证保存/预览拿到的是吸附后的合法值）
lineHeightInput.addEventListener('input', () => {
  const raw = Number.parseFloat(lineHeightInput.value);
  if (raw > 0 && raw < 1) lineHeightInput.value = String(sanitizeTranslationLineHeight(raw));
});
lineHeightInput.addEventListener('input', handleStyleInput);
lineHeightInput.addEventListener('change', handleStyleInput);
letterSpacingInput.addEventListener('input', handleStyleInput);
letterSpacingInput.addEventListener('change', handleStyleInput);

// ── 字幕翻译：独立存储键，同样走「双事件防抖自动保存 + 回读校验」──
interface SubtitleSnapshot {
  enabled: boolean;
  displayMode: SubtitleConfig['displayMode'];
  color: string;
  strokeColor: string;
  fontSize: number;
  shadowIntensity: number;
  fontFamily: string;
  hideNativeCaptions: boolean;
}

/** 字幕译文字体：与主译文样式的「预设栈 / 自定义名称」同一套合同。 */
const readSubtitleFontFamilyFromControls = (): string => {
  const selected = subtitleFontFamilySelect.value;
  if (selected === '__custom__') return sanitizeTranslationFontFamily(subtitleFontCustomInput.value);
  return sanitizeTranslationFontFamily(selected);
};

const readSubtitleFromControls = (): SubtitleSnapshot => ({
  enabled: subtitleEnabledInput.checked,
  displayMode: sanitizeSubtitleDisplayMode(subtitleModeInputs.find((input) => input.checked)?.value),
  color: sanitizeSubtitleColor(subtitleColorInput.value),
  strokeColor: sanitizeSubtitleStrokeColor(subtitleStrokeColorInput.value),
  fontSize: sanitizeSubtitleFontSize(subtitleFontSizeInput.value),
  shadowIntensity: sanitizeSubtitleShadow(subtitleShadowInput.value),
  fontFamily: readSubtitleFontFamilyFromControls(),
  hideNativeCaptions: subtitleHideNativeInput.checked,
});

const subtitleEquals = (a: SubtitleSnapshot, b: SubtitleSnapshot): boolean =>
  a.enabled === b.enabled
  && a.displayMode === b.displayMode
  && a.color === b.color
  && a.strokeColor === b.strokeColor
  && a.fontSize === b.fontSize
  && a.shadowIntensity === b.shadowIntensity
  && a.fontFamily === b.fontFamily
  && a.hideNativeCaptions === b.hideNativeCaptions;

/** 预览区与视频覆盖层共用同一组 --moyi-sub-* 变量契约。 */
const applySubtitlePreview = (): void => {
  const snapshot = readSubtitleFromControls();
  subtitlePreview.style.setProperty('--moyi-sub-color', snapshot.color);
  subtitlePreview.style.setProperty('--moyi-sub-font-size', `${snapshot.fontSize}px`);
  subtitlePreview.style.setProperty('--moyi-sub-shadow', buildShadowCss(snapshot.shadowIntensity));
  subtitlePreview.style.setProperty('--moyi-sub-stroke-color', snapshot.strokeColor);
  subtitlePreview.style.setProperty('--moyi-sub-stroke-width', `${buildStrokeWidthPx(snapshot.fontSize)}px`);
  if (snapshot.fontFamily.trim()) {
    subtitlePreview.style.setProperty('--moyi-sub-font-family', snapshot.fontFamily.trim());
  } else {
    subtitlePreview.style.removeProperty('--moyi-sub-font-family');
  }
  subtitlePreview.classList.remove('mode-bilingual', 'mode-translation', 'mode-original');
  subtitlePreview.classList.add(`mode-${snapshot.displayMode}`);
};

const syncRangeFill = (input: HTMLInputElement): void => {
  const min = Number.parseFloat(input.min) || 0;
  const max = Number.parseFloat(input.max) || 100;
  const value = Number.parseFloat(input.value) || min;
  const fill = Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
  input.style.setProperty('--range-fill', `${fill}%`);
};

const syncSubtitleControls = (): void => {
  const syncSwatchRow = (
    input: HTMLInputElement,
    hexLabel: HTMLSpanElement,
    swatches: HTMLButtonElement[],
    fallback: string,
  ): void => {
    const color = (input.value.match(/^#[0-9a-fA-F]{6}$/)?.[0] ?? fallback).toLowerCase();
    hexLabel.textContent = color.toUpperCase();
    swatches.forEach((swatch) => {
      swatch.setAttribute('aria-pressed', String(swatch.dataset.color === color));
    });
  };
  syncSwatchRow(subtitleColorInput, subtitleColorHex, subtitleColorSwatches, DEFAULT_SUBTITLE_CONFIG.color);
  syncSwatchRow(subtitleStrokeColorInput, subtitleStrokeColorHex, subtitleStrokeSwatches, DEFAULT_SUBTITLE_CONFIG.strokeColor);

  const fontSize = sanitizeSubtitleFontSize(subtitleFontSizeInput.value);
  subtitleFontSizeValue.textContent = `${fontSize}px`;
  subtitleFontSizeInput.setAttribute('aria-valuetext', `${fontSize}px`);
  syncRangeFill(subtitleFontSizeInput);

  const shadow = sanitizeSubtitleShadow(subtitleShadowInput.value);
  const shadowLabel = shadow === 0 ? '无' : `${Math.round(shadow * 100)}%`;
  subtitleShadowValue.textContent = shadowLabel;
  subtitleShadowInput.setAttribute('aria-valuetext', shadowLabel);
  syncRangeFill(subtitleShadowInput);

  applySubtitlePreview();
};

let lastSavedSubtitle: SubtitleSnapshot | null = null;
let subtitleSaveTimer: number | undefined;
/** 无设置页控件的字段：读取时记忆、保存时原样回写，避免误改。 */
let subtitleXEnabled = DEFAULT_SUBTITLE_CONFIG.xEnabled;
let subtitleAiSegmentation = DEFAULT_SUBTITLE_CONFIG.aiSegmentation;

const refreshSubtitleDirtyHint = (): void => {
  if (!lastSavedSubtitle || subtitleStatus.classList.contains('error')) return;
  setStatus(
    subtitleStatus,
    subtitleEquals(readSubtitleFromControls(), lastSavedSubtitle) ? '' : '有未保存的修改…',
  );
};

const saveSubtitleNow = async (): Promise<void> => {
  window.clearTimeout(subtitleSaveTimer);
  try {
    const snapshot = readSubtitleFromControls();
    const fullConfig: SubtitleConfig = {
      ...snapshot,
      xEnabled: subtitleXEnabled,
      aiSegmentation: subtitleAiSegmentation,
    };
    await saveSubtitleConfig(fullConfig);

    const verified = await getSubtitleConfig();
    if (!subtitleEquals(verified, fullConfig)) {
      setStatus(subtitleStatus, '保存未生效，请重试或检查浏览器存储权限。', 'error');
      return;
    }

    lastSavedSubtitle = { ...snapshot };
    logger.info('options.subtitle_save.success', { snapshot });
    showToast('字幕设置已保存');
    setStatus(subtitleStatus, '字幕设置已保存。', 'ok');
  } catch (error) {
    logger.error('options.subtitle_save.failure', { error });
    showToast('保存失败', 'error');
    setStatus(subtitleStatus, error instanceof Error ? error.message : '字幕设置保存失败。', 'error');
  }
};

const scheduleSubtitleSave = (): void => {
  window.clearTimeout(subtitleSaveTimer);
  subtitleSaveTimer = window.setTimeout(() => void saveSubtitleNow(), 400);
};

const handleSubtitleInput = (): void => {
  syncSubtitleControls();
  refreshSubtitleDirtyHint();
  scheduleSubtitleSave();
};

subtitleEnabledInput.addEventListener('input', handleSubtitleInput);
subtitleEnabledInput.addEventListener('change', handleSubtitleInput);
subtitleModeInputs.forEach((input) => {
  input.addEventListener('input', handleSubtitleInput);
  input.addEventListener('change', handleSubtitleInput);
});
subtitleColorInput.addEventListener('input', handleSubtitleInput);
subtitleColorInput.addEventListener('change', handleSubtitleInput);
subtitleColorSwatches.forEach((swatch) => {
  swatch.addEventListener('click', () => {
    subtitleColorInput.value = sanitizeSubtitleColor(swatch.dataset.color);
    handleSubtitleInput();
  });
});
subtitleStrokeColorInput.addEventListener('input', handleSubtitleInput);
subtitleStrokeColorInput.addEventListener('change', handleSubtitleInput);
subtitleStrokeSwatches.forEach((swatch) => {
  swatch.addEventListener('click', () => {
    subtitleStrokeColorInput.value = sanitizeSubtitleStrokeColor(swatch.dataset.color);
    handleSubtitleInput();
  });
});

/** 字幕字体控件联动：选「本机字体…」时显示自定义输入框。 */
const syncSubtitleFontControls = (): void => {
  const isCustom = subtitleFontFamilySelect.value === '__custom__';
  subtitleFontCustomInput.hidden = !isCustom;
};
subtitleFontFamilySelect.addEventListener('input', () => {
  syncSubtitleFontControls();
  handleSubtitleInput();
});
subtitleFontFamilySelect.addEventListener('change', handleSubtitleInput);
subtitleFontCustomInput.addEventListener('input', handleSubtitleInput);
subtitleFontCustomInput.addEventListener('change', handleSubtitleInput);
subtitleFontSizeInput.addEventListener('input', handleSubtitleInput);
subtitleFontSizeInput.addEventListener('change', handleSubtitleInput);
subtitleShadowInput.addEventListener('input', handleSubtitleInput);
subtitleShadowInput.addEventListener('change', handleSubtitleInput);
subtitleHideNativeInput.addEventListener('input', handleSubtitleInput);
subtitleHideNativeInput.addEventListener('change', handleSubtitleInput);

const loadSubtitleSettings = async (): Promise<void> => {
  let stored: SubtitleConfig;
  try {
    stored = await getSubtitleConfig();
  } catch {
    // 存储异常时回退默认值，保证控件仍可操作
    stored = { ...DEFAULT_SUBTITLE_CONFIG };
  }
  subtitleEnabledInput.checked = stored.enabled;
  subtitleXEnabled = stored.xEnabled !== false;
  subtitleAiSegmentation = stored.aiSegmentation !== false;
  const modeRadio = subtitleModeInputs.find((input) => input.value === stored.displayMode);
  if (modeRadio) modeRadio.checked = true;
  subtitleColorInput.value = stored.color;
  subtitleStrokeColorInput.value = stored.strokeColor;
  subtitleFontSizeInput.value = String(stored.fontSize);
  subtitleShadowInput.value = String(stored.shadowIntensity);
  // 字体反向映射：精确匹配预设栈则选中预设，否则进自定义输入框
  const storedFontFamily = stored.fontFamily.trim();
  const presetOption = storedFontFamily
    ? Array.from(subtitleFontFamilySelect.options).find(
        (option) => option.value !== '' && option.value !== '__custom__' && option.value === storedFontFamily)
    : undefined;
  if (!storedFontFamily) {
    subtitleFontFamilySelect.value = '';
  } else if (presetOption) {
    subtitleFontFamilySelect.value = storedFontFamily;
  } else {
    subtitleFontFamilySelect.value = '__custom__';
    subtitleFontCustomInput.value = storedFontFamily;
    subtitleFontCustomInput.hidden = false;
  }
  subtitleHideNativeInput.checked = stored.hideNativeCaptions;
  syncSubtitleControls();
  lastSavedSubtitle = readSubtitleFromControls();
};

const load = async (): Promise<void> => {
  let config: Awaited<ReturnType<typeof getConfig>>;
  try {
    config = await getConfig();
  } catch {
    // 静态预览或存储异常时回退默认配置，保证外观区仍可预览
    config = { ...DEFAULT_CONFIG };
  }
  currentConfig = config;
  disableReasoning.checked = config.disableReasoning;
  selectedProviderId = config.providerId;
  renderProviderRail();
  selectProvider(config.providerId);

  const presetInput = presetInputs.find((input) => input.value === config.translationStyle);
  if (presetInput) presetInput.checked = true;
  colorInput.value = config.translationColor;
  sizeInput.value = String(config.translationFontSize);
  lineHeightInput.value = String(config.translationLineHeight);
  letterSpacingInput.value = String(config.translationLetterSpacing);
  // 回填译文字体：匹配预设 option 则选中，自定义值进入输入框
  const fontFamily = sanitizeTranslationFontFamily(config.translationFontFamily);
  const presetOptions = Array.from(fontSelectInput.options).map((option) => option.value);
  if (!fontFamily) {
    fontSelectInput.value = '';
  } else if (presetOptions.includes(fontFamily)) {
    fontSelectInput.value = fontFamily;
    fontCustomInput.value = '';
  } else {
    fontSelectInput.value = '__custom__';
    fontCustomInput.value = fontFamily;
    fontCustomInput.hidden = false;
  }
  syncColorControls();
  syncSizeLabel();
  syncLineHeight();
  syncLetterSpacing();
  lastSavedTheme = readThemeFromControls();
  applyPreview();

  const promptRadio = promptStyleInputs.find((input) => input.value === config.promptStyle);
  if (promptRadio) promptRadio.checked = true;
  useCustomPromptInput.checked = config.useCustomPrompt;
  customPromptInput.value = config.customPrompt;
  customPromptInput.disabled = !config.useCustomPrompt;
  syncPromptCharCount();
  syncShortcutRows(config);
};

// ── 服务商管理：列表渲染 / 选择 / 保存并使用 / 测试 / 获取模型 ──
let currentConfig: Awaited<ReturnType<typeof getConfig>> | null = null;
let selectedProviderId = 'openai';
/** 当前编辑面板对应的已保存 API Key（不回填明文到输入框；留空视为保持不变）。 */
let activeSavedApiKey = '';
/** 当前编辑面板对应的已保存 SecretKey（腾讯翻译；留空视为保持不变）。 */
let activeSavedApiSecret = '';

/** 当前面板的有效 API Key：输入框新值优先，留空回退为已保存 Key。 */
const effectiveApiKey = (): string => apiKey.value.trim() || activeSavedApiKey;
/** 当前面板的有效 SecretKey：输入框新值优先，留空回退为已保存值。 */
const effectiveApiSecret = (): string => apiSecret.value.trim() || activeSavedApiSecret;
/** 正在编辑但尚未保存的自定义服务商草稿 id。 */
const draftProviderIds = new Set<string>();
/** 草稿对应的名字（仅内存，未保存前不落盘）。 */
const draftProviderNames = new Map<string, string>();

const buildProviderLogoElement = (id: string, meta: ProviderMeta, providers: Record<string, ProviderSettings>): HTMLElement => {
  const logo = document.createElement('span');
  logo.className = 'plogo';
  logo.style.setProperty('--c', meta.color);
  logo.setAttribute('aria-hidden', 'true');
  if (meta.logoSvg) {
    // logoSvg 为 providers.ts 内编译期常量，非用户数据
    logo.innerHTML = meta.logoSvg;
    return logo;
  }
  if (meta.svgPath) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', meta.svgPath);
    if (meta.svgPathFillRule) path.setAttribute('fill-rule', meta.svgPathFillRule);
    svg.appendChild(path);
    logo.appendChild(svg);
    return logo;
  }
  logo.textContent = getProviderMark(providers, id);
  return logo;
};

const applyPanelLogo = (id: string, meta: ProviderMeta): void => {
  providerLogo.innerHTML = '';
  providerLogo.style.setProperty('--c', meta.color);
  if (meta.logoSvg) {
    providerLogo.innerHTML = meta.logoSvg;
  } else if (meta.svgPath) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'currentColor');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', meta.svgPath);
    if (meta.svgPathFillRule) path.setAttribute('fill-rule', meta.svgPathFillRule);
    svg.appendChild(path);
    providerLogo.appendChild(svg);
  } else {
    providerLogo.textContent = getProviderMark(currentConfig?.providers, id);
  }
};

const renderProviderRail = (): void => {
  if (!currentConfig) return;
  const renderList = (container: HTMLDivElement, ids: string[]): void => {
    container.innerHTML = '';
    for (const id of ids) {
      const meta = getProviderMeta(id);
      const isActive = currentConfig!.providerId === id;
      const isEditing = id === selectedProviderId;
      const isEditingUnsaved = isEditing && !currentConfig!.providers[id];
      const draftName = draftProviderNames.get(id);
      const displayName = isEditingUnsaved && draftName
        ? draftName
        : getProviderDisplayName(currentConfig!.providers, id);
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `provider-item${isEditing ? ' selected' : ''}`;
      // 名称/标记为用户数据，一律经 textContent 写入，杜绝 innerHTML 注入
      const name = document.createElement('span');
      name.className = 'provider-name';
      name.textContent = displayName;
      const badge = document.createElement('span');
      badge.className = isActive ? 'pdot on' : 'pdot';
      if (isActive) badge.title = '使用中';
      item.append(buildProviderLogoElement(id, meta, currentConfig!.providers), name, badge);
      item.addEventListener('click', () => selectProvider(id));
      container.appendChild(item);
    }
  };

  // 分类展示：机器翻译（传统 MT API）→ 内置服务商（OpenAI 兼容）→ 自定义服务商
  renderList(mtProviderList, BUILT_IN_PROVIDERS.filter((provider) => provider.kind === 'mt').map((provider) => provider.id));
  renderList(builtinProviderList, BUILT_IN_PROVIDERS.filter((provider) => provider.kind !== 'mt').map((provider) => provider.id));

  const customIds = getCustomProviderIds(currentConfig.providers);
  // 正在编辑但尚未保存的空白服务商草稿也出现在列表中，直到保存或重开页面
  for (const draftId of draftProviderIds) {
    if (!customIds.includes(draftId)) customIds.push(draftId);
  }
  renderList(customProviderList, customIds);
};

const refreshProviderPanelState = (): void => {
  const isMt = isMtProviderId(selectedProviderId);
  const configured = isProviderConfigured({
    apiKey: effectiveApiKey(),
    apiSecret: effectiveApiSecret(),
    endpoint: endpoint.value,
    model: model.value,
  }, selectedProviderId);
  providerConfigured.textContent = configured
    ? (isMt ? `已配置：${getProviderDisplayName(currentConfig?.providers ?? {}, selectedProviderId)}` : `已配置：${model.value.trim()}`)
    : '未配置';
  providerConfigured.classList.toggle('on', configured);
  activeBadge.hidden = !currentConfig || currentConfig.providerId !== selectedProviderId;
};

const exitModelSelectMode = (): void => {
  modelSelect.innerHTML = '';
  modelSelect.hidden = true;
  manualModelButton.hidden = true;
  model.hidden = false;
};

const enterModelSelectMode = (models: string[]): void => {
  const current = model.value.trim();
  const names = models.slice(0, 100);
  if (current && !names.includes(current)) names.unshift(current);
  modelSelect.innerHTML = '';
  for (const name of names) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    modelSelect.appendChild(option);
  }
  modelSelect.value = current && names.includes(current) ? current : (names[0] ?? '');
  model.value = modelSelect.value;
  refreshProviderPanelState();
  model.hidden = true;
  modelSelect.hidden = false;
  manualModelButton.hidden = false;
};

modelSelect.addEventListener('change', () => {
  model.value = modelSelect.value;
  refreshProviderPanelState();
});

manualModelButton.addEventListener('click', () => {
  exitModelSelectMode();
  model.focus();
});

const selectProvider = (id: string): void => {
  if (!currentConfig) return;
  selectedProviderId = id;
  // 状态行属于当前编辑面板：切换服务商即清空上一面板的忙碌/结果状态
  setStatus(serviceStatus, '');
  const meta = getProviderMeta(id);
  const isMt = isMtProviderId(id);
  const isDeepl = isDeeplProviderId(id);
  const isTencent = id === 'tencent';
  const isMicrosoft = id === 'microsoft';
  const isGoogle = id === 'google';
  const isNoKeyMt = isNoKeyMtProviderId(id);
  const runtime = resolveProviderSettings(currentConfig, id);
  endpoint.value = runtime.endpoint;
  activeSavedApiKey = runtime.apiKey.trim();
  // 已存 Key 只以掩码占位提示，不回填明文进 DOM（防截屏/录屏/页面被攻陷时直接读取）
  apiKey.value = '';
  apiKey.placeholder = activeSavedApiKey
    ? '已保存（留空保持不变，输入新值以替换）'
    : (isTencent ? 'SecretId（腾讯云 API 密钥 ID）' : 'sk-…');
  apiKeyLabel.textContent = isTencent ? 'SecretId（API 密钥 ID）' : 'API Key';
  activeSavedApiSecret = runtime.apiSecret.trim();
  apiSecret.value = '';
  apiSecret.placeholder = activeSavedApiSecret ? '已保存（留空保持不变，输入新值以替换）' : 'SecretKey';
  region.value = runtime.region || 'ap-guangzhou';
  model.value = runtime.model;
  exitModelSelectMode();
  applyPanelLogo(id, meta);
  providerName.textContent = getProviderDisplayName(currentConfig.providers, id);
  const isCustom = isCustomProviderId(id);
  customNameField.hidden = !isCustom;
  if (isCustom) {
    providerNameInput.value = currentConfig.providers[id]?.name ?? draftProviderNames.get(id) ?? '';
  }
  const hasSavedEntry = Boolean(currentConfig.providers[id]);
  deleteProviderButton.hidden = !(isCustom && (hasSavedEntry || draftProviderIds.has(id)));
  // 传统 MT（DeepL / 腾讯）：隐藏模型与推理开关
  modelField.hidden = isMt;
  disableReasoningRow.hidden = isMt;
  // DeepL：显示免费/专业套餐选择；腾讯：显示 SecretKey / Region 与申请指引
  deeplPlanField.hidden = !isDeepl;
  tencentFields.hidden = !isTencent;
  // 微软/谷歌翻译：免密钥，隐藏接口地址/密钥等凭据字段，显示对应说明
  serviceFields.hidden = isNoKeyMt;
  microsoftHint.hidden = !isMicrosoft;
  googleHint.hidden = !isGoogle;
  if (isDeepl) {
    deeplPlanSelect.value = endpoint.value.includes('api.deepl.com') && !endpoint.value.includes('api-free')
      ? 'https://api.deepl.com/v2'
      : 'https://api-free.deepl.com/v2';
  }
  refreshProviderPanelState();
  renderProviderRail();
};

deeplPlanSelect.addEventListener('change', () => {
  endpoint.value = deeplPlanSelect.value;
  refreshProviderPanelState();
});

const saveProviderNow = async (): Promise<void> => {
  try {
    const apiKeyValue = effectiveApiKey();
    const apiSecretValue = effectiveApiSecret();
    const endpointValue = endpoint.value.trim() || getProviderMeta(selectedProviderId).endpoint;
    const modelValue = model.value.trim();
    const isMt = isMtProviderId(selectedProviderId);
    const isTencent = selectedProviderId === 'tencent';
    const isNoKeyMt = isNoKeyMtProviderId(selectedProviderId);
    if (!isNoKeyMt && (!apiKeyValue || !endpointValue || (!isMt && !modelValue))) {
      setStatus(serviceStatus, isMt ? '请填写接口地址与 API Key（腾讯翻译另需 SecretKey）。' : '请填写接口地址、API Key 与模型名称后再保存。', 'error');
      return;
    }
    if (isTencent && !apiSecretValue) {
      setStatus(serviceStatus, '腾讯翻译需要 SecretKey：SecretId 填在上方「SecretId」字段，SecretKey 填在下方「SecretKey」字段。', 'error');
      return;
    }
    const base = await getConfig();
    const customSettings: Partial<ProviderSettings> = {};
    if (isCustomProviderId(selectedProviderId) && providerNameInput.value.trim()) {
      customSettings.name = providerNameInput.value.trim().slice(0, 24);
    }
    const providerEntry: ProviderSettings = isNoKeyMt
      ? { apiKey: '', endpoint: '' }
      : {
          apiKey: apiKeyValue,
          endpoint: endpointValue,
          ...(isMt ? {} : { model: modelValue }),
          ...(isTencent ? { apiSecret: apiSecretValue, region: region.value.trim() || 'ap-guangzhou' } : {}),
          ...customSettings,
        };
    const providers = {
      ...base.providers,
      [selectedProviderId]: providerEntry,
    };
    await saveConfig({
      ...base,
      providerId: selectedProviderId,
      providers,
      apiKey: apiKeyValue,
      endpoint: endpointValue,
      model: isMt ? '' : modelValue,
      disableReasoning: disableReasoning.checked,
    });

    const verified = await getConfig();
    const stored = verified.providers[selectedProviderId];
    if (
      verified.providerId !== selectedProviderId ||
      stored?.apiKey !== apiKeyValue ||
      verified.apiKey !== apiKeyValue ||
      verified.endpoint !== endpointValue ||
      (isTencent && stored?.apiSecret !== apiSecretValue)
    ) {
      setStatus(serviceStatus, '保存未生效，请重试。', 'error');
      return;
    }
    currentConfig = verified;
    draftProviderIds.delete(selectedProviderId);
    draftProviderNames.delete(selectedProviderId);
    selectProvider(selectedProviderId);
    logger.info('options.provider_save.success', { providerId: selectedProviderId });
    showToast('已保存');
    setStatus(serviceStatus, '已保存。', 'ok');
  } catch (error) {
    logger.error('options.provider_save.failure', { error });
    showToast('保存失败', 'error');
    setStatus(serviceStatus, error instanceof Error ? error.message : '保存失败。', 'error');
  }
};

// ── 添加/删除自定义服务商 ──
addCustomProviderButton.addEventListener('click', () => {
  if (!currentConfig) return;
  const id = createCustomProviderId();
  draftProviderIds.add(id);
  draftProviderNames.delete(id);
  selectedProviderId = id;
  endpoint.value = '';
  activeSavedApiKey = '';
  apiKey.value = '';
  apiKey.placeholder = 'sk-…';
  model.value = '';
  exitModelSelectMode();
  const meta = getProviderMeta(id);
  applyPanelLogo(id, meta);
  providerName.textContent = getProviderDisplayName(currentConfig.providers, id);
  customNameField.hidden = false;
  providerNameInput.value = '';
  deleteProviderButton.hidden = true;
  // 自定义服务商走 OpenAI 兼容后端，恢复模型/推理等字段显示
  modelField.hidden = false;
  disableReasoningRow.hidden = false;
  deeplPlanField.hidden = true;
  refreshProviderPanelState();
  renderProviderRail();
  providerNameInput.focus();
});

// 新建/编辑自定义服务商时，名字输入即时反馈到面板标题与左侧列表
providerNameInput.addEventListener('input', () => {
  if (!currentConfig || !isCustomProviderId(selectedProviderId)) return;
  const name = providerNameInput.value.trim();
  if (!currentConfig.providers[selectedProviderId]) {
    if (name) draftProviderNames.set(selectedProviderId, name);
    else draftProviderNames.delete(selectedProviderId);
  }
  providerName.textContent = name || '自定义服务商';
  renderProviderRail();
});

deleteProviderButton.addEventListener('click', () => {
  void (async () => {
    const id = selectedProviderId;
    if (!currentConfig || !isCustomProviderId(id)) return;
    const isDraft = !currentConfig.providers[id];
    if (!isDraft && !draftProviderIds.has(id)) return;
    const name = getProviderDisplayName(currentConfig.providers, id);
    if (!window.confirm(isDraft ? `确定放弃「${name}」？尚未保存的配置将被丢弃。` : `确定删除「${name}」？此操作会清除其 API Key 与配置，无法撤销。`)) return;

    // 草稿：直接从内存移除并回到内置服务商
    if (isDraft) {
      draftProviderIds.delete(id);
      draftProviderNames.delete(id);
      selectedProviderId = 'openai';
      renderProviderRail();
      selectProvider('openai');
      showToast(`已放弃「${name}」`);
      setStatus(serviceStatus, '已放弃未保存的自定义服务商。', 'ok');
      return;
    }

    const base = currentConfig;
    const providers = { ...base.providers };
    delete providers[id];
    const nextProviderId = base.providerId === id ? 'openai' : base.providerId;
    const nextRuntime = resolveProviderSettings({ providers }, nextProviderId);
    try {
      await saveConfig({
        ...base,
        providerId: nextProviderId,
        providers,
        apiKey: nextRuntime.apiKey,
        endpoint: nextRuntime.endpoint,
        model: nextRuntime.model,
      });
      const verified = await getConfig();
      currentConfig = verified;
      selectProvider(verified.providerId);
      logger.info('options.provider_delete.success', { providerId: id });
      showToast(`已删除「${name}」`);
      setStatus(
        serviceStatus,
        `已删除「${name}」，当前服务为${getProviderDisplayName(verified.providers, verified.providerId)}。`,
        'ok',
      );
    } catch (error) {
      logger.error('options.provider_delete.failure', { error });
      showToast('删除失败', 'error');
      setStatus(serviceStatus, error instanceof Error ? error.message : '删除失败。', 'error');
    }
  })();
});

// ── API Key 可见性 ──
toggleKeyVisibilityButton.addEventListener('click', () => {
  apiKey.type = apiKey.type === 'password' ? 'text' : 'password';
});

// ── 自定义提示词字数统计 ──
const syncPromptCharCount = (): void => {
  promptCharCount.textContent = String(customPromptInput.value.length);
};
customPromptInput.addEventListener('input', syncPromptCharCount);

document.querySelector<HTMLButtonElement>('#save')!.addEventListener('click', () => void saveProviderNow());

document.querySelector<HTMLButtonElement>('#test')!.addEventListener('click', () => {
  void (async () => {
    const testingFor = selectedProviderId;
    const stillOnPanel = (): boolean => selectedProviderId === testingFor;
    try {
      const isNoKeyMt = isNoKeyMtProviderId(testingFor);
      // 微软/谷歌翻译免密钥：不要求 API Key；接口地址留空时回退内置默认
      const endpointValue = endpoint.value.trim() || getProviderMeta(testingFor).endpoint;
      const apiKeyValue = effectiveApiKey();
      if (!endpointValue || (!apiKeyValue && !isNoKeyMt)) {
        setStatus(serviceStatus, isNoKeyMt ? '无需填写任何字段，直接点击即可测试。' : '请先填写接口地址与 API Key。', 'error');
        return;
      }
      setStatus(serviceStatus, '正在测试连接…', 'busy');
      logger.info('options.connection_test.start', { endpoint: endpointValue, model: model.value.trim() });
      const result = await chrome.runtime.sendMessage({
        type: 'test-connection',
        endpoint: endpointValue,
        apiKey: apiKeyValue,
        apiSecret: effectiveApiSecret(),
        region: region.value.trim(),
        model: model.value.trim(),
        kind: getProviderMeta(testingFor).kind,
        providerId: testingFor,
      }) as { ok?: boolean; pong?: string; error?: string };
      if (!result?.ok) throw new Error(result?.error || '模型连接失败。');
      logger.info('options.connection_test.success');
      // 结果只写回发起测试的服务商面板，切换服务商后丢弃
      if (stillOnPanel()) setStatus(serviceStatus, '连接成功。', 'ok');
    } catch (error) {
      logger.error('options.connection_test.failure', { error });
      if (!stillOnPanel()) return;
      const reason = error instanceof Error ? error.message : '未知错误';
      setStatus(serviceStatus, `连接失败：${reason}。请检查 API Key 或 Base URL。`, 'error');
    }
  })();
});

fetchModelsButton.addEventListener('click', () => {
  void (async () => {
    const fetchFor = selectedProviderId;
    const stillOnPanel = (): boolean => selectedProviderId === fetchFor;
    const endpointValue = endpoint.value.trim();
    if (!endpointValue) {
      setStatus(serviceStatus, '请先填写接口地址。', 'error');
      return;
    }
    const meta = getProviderMeta(fetchFor);
    const fillModels = (models: string[], note?: string): void => {
      // 结果只回写发起请求的服务商面板，切换服务商后丢弃
      if (!stillOnPanel()) return;
      if (models.length > 0) {
        enterModelSelectMode(models);
      } else {
        exitModelSelectMode();
      }
      if (note) setStatus(serviceStatus, note, 'idle');
      else setStatus(serviceStatus, `已获取 ${models.length} 个模型，下拉选择即可。`, 'ok');
    };
    fetchModelsButton.disabled = true;
    setStatus(serviceStatus, '正在获取模型列表…', 'busy');
    logger.info('options.fetch_models.start', { endpoint: endpointValue, hasKey: apiKey.value.trim().length > 0 });
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'fetch-models',
        endpoint: endpointValue,
        apiKey: effectiveApiKey(),
        kind: meta.kind,
      }) as { ok?: boolean; models?: string[]; error?: string };
      const models = result?.ok && Array.isArray(result.models) ? result.models : [];
      logger.info('options.fetch_models.response', { ok: Boolean(result?.ok), count: models.length, error: result?.error });
      if (models.length > 0) {
        fillModels(models);
      } else if (result?.error) {
        if (/\(HTTP 40[45]\)/.test(result.error)) {
          fillModels(
            [...meta.fallbackModels],
            '该接口地址不提供模型列表（服务商未开放 /models），已显示常用模型备选，可直接选用或手动输入。',
          );
        } else {
          fillModels([...meta.fallbackModels], `${result.error}（已显示常用模型备选）`);
        }
      } else {
        fillModels([...meta.fallbackModels], '服务商未返回模型列表（已显示常用模型备选）。');
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      logger.error('options.fetch_models.failure', { error });
      if (!stillOnPanel()) return;
      if (/context invalidated/i.test(messageText)) {
        setStatus(serviceStatus, '扩展已重新加载，请刷新本页面后重试。', 'error');
        exitModelSelectMode();
      } else {
        fillModels([...meta.fallbackModels], `获取失败：${messageText || '未知错误'}（已显示常用模型备选）`);
      }
    } finally {
      fetchModelsButton.disabled = false;
    }
  })();
});

[endpoint, apiKey, apiSecret, region, model].forEach((input) => {
  input.addEventListener('input', refreshProviderPanelState);
});

openShortcutsButton.addEventListener('click', () => {
  void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// ── 应用内快捷键：录制组合键 → 保存到配置（页面内 keydown 触发） ──
const isMacPlatform = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);

const syncShortcutRows = (config: Awaited<ReturnType<typeof getConfig>>): void => {
  // 未设置时显示「设置」作为可点击入口；录制完成显示组合键
  translateShortcutDisplay.textContent = config.shortcuts.translate
    ? formatShortcut(config.shortcuts.translate, isMacPlatform)
    : '设置';
  restoreShortcutDisplay.textContent = config.shortcuts.restore
    ? formatShortcut(config.shortcuts.restore, isMacPlatform)
    : '设置';
  clearTranslateShortcutButton.hidden = !config.shortcuts.translate;
  clearRestoreShortcutButton.hidden = !config.shortcuts.restore;
};

const beginShortcutRecording = async (
  target: 'translate' | 'restore',
  displayEl: HTMLElement,
): Promise<void> => {
  const label = target === 'translate' ? '翻译' : '还原';
  if (displayEl.classList.contains('recording')) return;
  displayEl.classList.add('recording');
  displayEl.setAttribute('aria-disabled', 'true');
  displayEl.textContent = '请按组合键…';
  try {
    const combo = await waitForKeyCombo();
    if (combo === null) {
      showToast('已取消录制');
      syncShortcutRows(await getConfig());
      return;
    }
    const validationError = validateShortcut(combo);
    if (validationError) {
      showToast(validationError, 'error');
      syncShortcutRows(await getConfig());
      return;
    }
    const config = await getConfig();
    const other = target === 'translate' ? config.shortcuts.restore : config.shortcuts.translate;
    if (other === combo) {
      showToast(`「${label}」与另一动作的快捷键相同，请换一个组合。`, 'error');
      syncShortcutRows(config);
      return;
    }
    await saveConfig({ ...config, shortcuts: { ...config.shortcuts, [target]: combo } });
    syncShortcutRows({ ...config, shortcuts: { ...config.shortcuts, [target]: combo } });
    showToast(`「${label}」已设为 ${formatShortcut(combo, isMacPlatform)}`);
  } catch (error) {
    logger.error('options.shortcut_record.failure', { target, error });
    showToast(error instanceof Error ? error.message : '录制失败。', 'error');
  } finally {
    displayEl.classList.remove('recording');
    displayEl.removeAttribute('aria-disabled');
  }
};

const clearShortcut = async (target: 'translate' | 'restore'): Promise<void> => {
  const config = await getConfig();
  await saveConfig({ ...config, shortcuts: { ...config.shortcuts, [target]: '' } });
  syncShortcutRows({ ...config, shortcuts: { ...config.shortcuts, [target]: '' } });
  showToast(target === 'translate' ? '已清除翻译快捷键' : '已清除还原快捷键');
};

const attachShortcutRecording = (target: 'translate' | 'restore', displayEl: HTMLElement): void => {
  displayEl.addEventListener('click', () => {
    void beginShortcutRecording(target, displayEl);
  });
  displayEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    void beginShortcutRecording(target, displayEl);
  });
};

attachShortcutRecording('translate', translateShortcutDisplay);
attachShortcutRecording('restore', restoreShortcutDisplay);
clearTranslateShortcutButton.addEventListener('click', () => {
  void clearShortcut('translate');
});
clearRestoreShortcutButton.addEventListener('click', () => {
  void clearShortcut('restore');
});

// ── 提示词：显式保存 + 回读校验 ──
const collectPromptSettings = () => ({
  promptStyle: sanitizePromptStyle(promptStyleInputs.find((input) => input.checked)?.value),
  useCustomPrompt: useCustomPromptInput.checked,
  customPrompt: customPromptInput.value.trim(),
});

const savePromptNow = async (): Promise<void> => {
  try {
    const settings = collectPromptSettings();
    const config = await getConfig();
    await saveConfig({ ...config, ...settings });

    const verified = await getConfig();
    if (
      verified.promptStyle !== settings.promptStyle ||
      verified.useCustomPrompt !== settings.useCustomPrompt ||
      verified.customPrompt !== settings.customPrompt
    ) {
      setStatus(promptStatus, '保存未生效，请重试。', 'error');
      return;
    }
    logger.info('options.prompt_save.success', {
      promptStyle: settings.promptStyle,
      useCustomPrompt: settings.useCustomPrompt,
    });
    showToast('提示词已保存');
    setStatus(promptStatus, '提示词已保存。', 'ok');
  } catch (error) {
    logger.error('options.prompt_save.failure', { error });
    showToast('保存失败', 'error');
    setStatus(promptStatus, error instanceof Error ? error.message : '提示词保存失败。', 'error');
  }
};

promptStyleInputs.forEach((input) => {
  input.addEventListener('change', () => void savePromptNow());
});
useCustomPromptInput.addEventListener('change', () => {
  customPromptInput.disabled = !useCustomPromptInput.checked;
  void savePromptNow();
});
customPromptInput.addEventListener('blur', () => {
  if (useCustomPromptInput.checked && customPromptInput.value.trim()) void savePromptNow();
});
savePromptButton.addEventListener('click', () => void savePromptNow());

// ── 恢复全部默认配置（恢复出厂） ──
resetAllButton.addEventListener('click', () => {
  void (async () => {
    if (!(await confirmDanger())) return;
    try {
      await saveConfig({ ...DEFAULT_CONFIG });
      // 字幕翻译配置随恢复出厂一并还原（独立存储键，需单独写默认值）
      await saveSubtitleConfig({ ...DEFAULT_SUBTITLE_CONFIG });
      await clearTranslationCache();
      window.location.reload();
    } catch (error) {
      setStatus(promptStatus, error instanceof Error ? error.message : '重置失败。', 'error');
    }
  })();
});

// ── 侧边栏导航：每个分区独立成页，点击即切换视图 ──
const navItems = Array.from(document.querySelectorAll<HTMLButtonElement>('.nav-item'));
const sections = ['sec-service', 'sec-prompt', 'sec-style', 'sec-subtitle', 'sec-shortcuts', 'sec-about', 'sec-settings']
  .map((id) => document.getElementById(id))
  .filter((element): element is HTMLElement => element !== null);
const showSection = (targetId: string): void => {
  navItems.forEach((item) => {
    const active = item.dataset.target === targetId;
    item.classList.toggle('active', active);
    item.setAttribute('aria-current', active ? 'page' : 'false');
  });
  sections.forEach((section) => section.classList.toggle('active', section.id === targetId));
};
navItems.forEach((item) => {
  item.addEventListener('click', () => showSection(item.dataset.target ?? ''));
});
openGuideButton.addEventListener('click', () => showSection('sec-about'));
showSection('sec-service');

// ── 恢复默认样式 ──
document.querySelector<HTMLButtonElement>('#resetStyle')!.addEventListener('click', () => {
  void (async () => {
    const defaultRadio = presetInputs.find((input) => input.value === DEFAULT_CONFIG.translationStyle);
    if (defaultRadio) defaultRadio.checked = true;
    colorInput.value = DEFAULT_CONFIG.translationColor;
    sizeInput.value = String(DEFAULT_CONFIG.translationFontSize);
    lineHeightInput.value = String(DEFAULT_CONFIG.translationLineHeight);
    letterSpacingInput.value = String(DEFAULT_CONFIG.translationLetterSpacing);
    fontSelectInput.value = '';
    fontCustomInput.value = '';
    fontCustomInput.hidden = true;
    syncColorControls();
    syncSizeLabel();
    syncLineHeight();
    syncLetterSpacing();
    applyPreview();
    await saveStyleNow();
  })();
});

// ── 恢复默认字幕设置 ──
resetSubtitleButton.addEventListener('click', () => {
  void (async () => {
    subtitleEnabledInput.checked = DEFAULT_SUBTITLE_CONFIG.enabled;
    const modeRadio = subtitleModeInputs.find((input) => input.value === DEFAULT_SUBTITLE_CONFIG.displayMode);
    if (modeRadio) modeRadio.checked = true;
    subtitleColorInput.value = DEFAULT_SUBTITLE_CONFIG.color;
    subtitleStrokeColorInput.value = DEFAULT_SUBTITLE_CONFIG.strokeColor;
    subtitleFontSizeInput.value = String(DEFAULT_SUBTITLE_CONFIG.fontSize);
    subtitleShadowInput.value = String(DEFAULT_SUBTITLE_CONFIG.shadowIntensity);
    subtitleFontFamilySelect.value = DEFAULT_SUBTITLE_CONFIG.fontFamily;
    subtitleFontCustomInput.value = '';
    subtitleFontCustomInput.hidden = true;
    subtitleHideNativeInput.checked = DEFAULT_SUBTITLE_CONFIG.hideNativeCaptions;
    syncSubtitleControls();
    await saveSubtitleNow();
  })();
});

// ── 本机字体枚举（Local Font Access API）──
// 浏览器禁止页面静默读取系统字体清单（防指纹），枚举必须经用户手势 + 授权弹窗。
// 扫描结果填入共享 datalist，供「译文样式」与「字幕翻译」两处自定义输入框联想。
interface LocalFontData {
  family?: string;
}

let fontScanInFlight = false;

const scanLocalFonts = async (statusEl: HTMLElement, revealCustom: () => void): Promise<void> => {
  const api = (window as unknown as { queryLocalFonts?: () => Promise<LocalFontData[]> }).queryLocalFonts;
  if (typeof api !== 'function') {
    setStatus(statusEl, '当前浏览器不支持字体枚举（需要 Chrome 103+）。', 'error');
    return;
  }
  if (fontScanInFlight) return;
  fontScanInFlight = true;
  try {
    setStatus(statusEl, '等待授权并列出本机字体…', 'busy');
    const fonts = await api.call(window);
    const seen = new Set<string>();
    const families: string[] = [];
    for (const font of fonts) {
      const family = typeof font?.family === 'string' ? font.family.trim() : '';
      if (family && !seen.has(family)) {
        seen.add(family);
        families.push(family);
      }
    }
    // CJK 常见关键字族置顶，便于快速定位中文字体
    const cjkPattern = /(黑|宋|楷|仿|圆|雅|隶|篆|明|思源|霞鹜|得意|Han|Hei|Song|Kai|Ming|Gothic|CJK)/i;
    families.sort((a, b) => {
      const rank = (name: string): number => (cjkPattern.test(name) ? 0 : 1);
      return rank(a) - rank(b) || a.localeCompare(b, 'zh-Hans-CN');
    });
    localFontOptionsList.replaceChildren(
      ...families.map((family) => {
        const option = document.createElement('option');
        option.value = family;
        return option;
      }),
    );
    setStatus(statusEl, `已发现 ${families.length} 个本机字体族：在自定义输入框中即可联想选择。`, 'ok');
    revealCustom();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(statusEl, /denied|dismissed|拒绝/i.test(message)
      ? '未获得字体访问授权；可再次点击并在弹窗中选择允许。'
      : `扫描本机字体失败：${message}`, 'error');
  } finally {
    fontScanInFlight = false;
  }
};

const revealStyleFontCustom = (): void => {
  fontSelectInput.value = '__custom__';
  handleStyleInput();
};

const revealSubtitleFontCustom = (): void => {
  subtitleFontFamilySelect.value = '__custom__';
  syncSubtitleFontControls();
  handleSubtitleInput();
  subtitleFontCustomInput.focus();
};

scanLocalFontsStyleButton.addEventListener('click', () => {
  void scanLocalFonts(styleStatus, revealStyleFontCustom);
});
scanLocalFontsSubtitleButton.addEventListener('click', () => {
  void scanLocalFonts(subtitleStatus, revealSubtitleFontCustom);
});

void load();
void loadSubtitleSettings();
