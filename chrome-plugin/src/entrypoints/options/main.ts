// 共享设计 token：WXT 构建时注入 <head>，必须先于页面自身样式表生效
import '../../styles/tokens.css';
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
import { PROMPT_STYLES, sanitizePromptStyle } from '../../utils/prompts';
import { parseGlossaryText, sanitizeGlossary, type GlossaryEntry } from '../../utils/glossary';
import { formatVocabDate, loadVocabBook, saveVocabBook, toVocabCsv, toVocabJson, type VocabEntry } from '../../utils/vocabbook';
import {
  afterDraftRemoved,
  afterProviderSaved,
  canDeleteProvider,
  deleteConfirmCopy,
  nextActiveProviderAfterDelete,
  nextDraftNames,
  resolveProviderName,
  withoutProvider,
  type DraftState,
} from '../../utils/providerEditor';
import { createTtsQueue, resolveTargetSpeechLang } from '../../utils/tts';
import { PICKED_ELEMENT_KEY, type PickedElement } from '../../utils/pickedElement';
import { applyRuleEdit, buildRuleFromForm, parseSelectorLines, sanitizeRuleSubscriptions, summarizeRule, type SiteRule } from '../../utils/siteRules';
import { isRuleCacheFresh, loadRuleCache, saveRuleCache, RULE_CACHE_MAX_AGE_MS } from '../../utils/ruleRepository';
import {
  PROFILES_MAX,
  applyProfile,
  buildProfileSnapshot,
  mergeSnapshot,
  mergeSubscriptionResults,
  nextProfilesOnSave,
  parseConfigBackup,
  pushConfigHistory,
  sanitizeProfiles,
  sanitizeWebDavSettings,
  serializeConfigBackup,
  webDavGet,
  webDavProbe,
  webDavPut,
  type ConfigHistoryEntry,
  type SceneProfile,
  type WebDavSettings,
} from '../../utils/configSync';
import {
  createCustomProviderId,
  isDeeplProviderId,
  isMtProviderId,
  isNoKeyMtProviderId,
  type ProviderMeta,
  type ProviderSettings,
} from '../../utils/providers';
import {
  EXTENSION_BUILT_IN_PROVIDERS as BUILT_IN_PROVIDERS,
  getExtensionCustomProviderIds as getCustomProviderIds,
  getExtensionProviderDisplayName as getProviderDisplayName,
  getExtensionProviderMark as getProviderMark,
  getExtensionProviderMeta as getProviderMeta,
  isExtensionCustomProviderId as isCustomProviderId,
  isExtensionProviderConfigured as isProviderConfigured,
  isOllamaProviderId,
  resolveExtensionProviderSettings as resolveProviderSettings,
} from '../../utils/extensionProviders';
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
const ollamaHint = document.querySelector<HTMLParagraphElement>('#ollamaHint')!;

const isKeylessProvider = (id: string): boolean =>
  isOllamaProviderId(id) || isNoKeyMtProviderId(id);
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
const apiKeyField = document.querySelector<HTMLDivElement>('#apiKeyField')!;
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
const floatSizeInput = document.querySelector<HTMLInputElement>('#floatSize')!;
const floatSizeValue = document.querySelector<HTMLSpanElement>('#floatSizeValue')!;
const floatOpacityInput = document.querySelector<HTMLInputElement>('#floatOpacity')!;
const floatOpacityValue = document.querySelector<HTMLSpanElement>('#floatOpacityValue')!;
const openShortcutsButton = document.querySelector<HTMLButtonElement>('#openShortcuts')!;
const clearTranslateShortcutButton = document.querySelector<HTMLButtonElement>('#clearTranslateShortcut')!;
const translateShortcutDisplay = document.querySelector<HTMLElement>('#translateShortcutDisplay')!;
const clearRestoreShortcutButton = document.querySelector<HTMLButtonElement>('#clearRestoreShortcut')!;
const restoreShortcutDisplay = document.querySelector<HTMLElement>('#restoreShortcutDisplay')!;
const inputTranslateShortcutDisplay = document.querySelector<HTMLElement>('#inputTranslateShortcutDisplay')!;
const clearInputTranslateShortcutButton = document.querySelector<HTMLButtonElement>('#clearInputTranslateShortcut')!;
const lookupShortcutDisplay = document.querySelector<HTMLElement>('#lookupShortcutDisplay')!;
const clearLookupShortcutButton = document.querySelector<HTMLButtonElement>('#clearLookupShortcut')!;

/** 应用内快捷键的动作域（与 PageShortcuts 键名一一对应）。 */
type ShortcutTarget = 'translate' | 'restore' | 'inputTranslate' | 'lookup';
const promptStyleInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="prompt-style"]'));
const useCustomPromptInput = document.querySelector<HTMLInputElement>('#useCustomPrompt')!;
const customPromptInput = document.querySelector<HTMLTextAreaElement>('#customPrompt')!;
const savePromptButton = document.querySelector<HTMLButtonElement>('#savePrompt')!;
const promptStatus = document.querySelector<HTMLDivElement>('#promptStatus')!;
const glossaryRows = document.querySelector<HTMLDivElement>('#glossaryRows')!;
const glossaryAddButton = document.querySelector<HTMLButtonElement>('#glossaryAdd')!;
const glossaryImportButton = document.querySelector<HTMLButtonElement>('#glossaryImport')!;
const glossaryExportButton = document.querySelector<HTMLButtonElement>('#glossaryExport')!;
const glossaryFileInput = document.querySelector<HTMLInputElement>('#glossaryFile')!;
const glossaryStatus = document.querySelector<HTMLDivElement>('#glossaryStatus')!;
const glossaryPasteButton = document.querySelector<HTMLButtonElement>('#glossaryPaste')!;
const glossaryPasteBox = document.querySelector<HTMLDivElement>('#glossaryPasteBox')!;
const glossaryPasteInput = document.querySelector<HTMLTextAreaElement>('#glossaryPasteInput')!;
const glossaryPasteApplyButton = document.querySelector<HTMLButtonElement>('#glossaryPasteApply')!;
const glossaryPasteCancelButton = document.querySelector<HTMLButtonElement>('#glossaryPasteCancel')!;
const selectionLookupInput = document.querySelector<HTMLInputElement>('#selectionLookupEnabled')!;
const selectionHoverInput = document.querySelector<HTMLInputElement>('#selectionHoverEnabled')!;
const vocabSearch = document.querySelector<HTMLInputElement>('#vocabSearch')!;
const vocabList = document.querySelector<HTMLDivElement>('#vocabList')!;
const vocabEmpty = document.querySelector<HTMLDivElement>('#vocabEmpty')!;
const vocabStatus = document.querySelector<HTMLDivElement>('#vocabStatus')!;
const vocabAnkiExport = document.querySelector<HTMLButtonElement>('#vocabAnkiExport')!;
const vocabAnkiStatus = document.querySelector<HTMLDivElement>('#vocabAnkiStatus')!;
const vocabExportCsvButton = document.querySelector<HTMLButtonElement>('#vocabExportCsv')!;
const vocabExportJsonButton = document.querySelector<HTMLButtonElement>('#vocabExportJson')!;
const vocabClearButton = document.querySelector<HTMLButtonElement>('#vocabClear')!;
// ── 备份与同步分区 ──
const configExportButton = document.querySelector<HTMLButtonElement>('#configExport')!;
const configImportButton = document.querySelector<HTMLButtonElement>('#configImport')!;
const configFileInput = document.querySelector<HTMLInputElement>('#configFile')!;
const configBackupStatus = document.querySelector<HTMLDivElement>('#configBackupStatus')!;
const configHistoryList = document.querySelector<HTMLDivElement>('#configHistoryList')!;
const configHistoryEmpty = document.querySelector<HTMLDivElement>('#configHistoryEmpty')!;
const webdavUrlInput = document.querySelector<HTMLInputElement>('#webdavUrl')!;
const webdavUsernameInput = document.querySelector<HTMLInputElement>('#webdavUsername')!;
const webdavPasswordInput = document.querySelector<HTMLInputElement>('#webdavPassword')!;
const webdavPathInput = document.querySelector<HTMLInputElement>('#webdavPath')!;
const webdavTestButton = document.querySelector<HTMLButtonElement>('#webdavTest')!;
const webdavUploadButton = document.querySelector<HTMLButtonElement>('#webdavUpload')!;
const webdavDownloadButton = document.querySelector<HTMLButtonElement>('#webdavDownload')!;
const webdavStatus = document.querySelector<HTMLDivElement>('#webdavStatus')!;
const profileNameInput = document.querySelector<HTMLInputElement>('#profileName')!;
const profileSaveButton = document.querySelector<HTMLButtonElement>('#profileSave')!;
const profileList = document.querySelector<HTMLDivElement>('#profileList')!;
const profileEmpty = document.querySelector<HTMLDivElement>('#profileEmpty')!;
const profileStatus = document.querySelector<HTMLDivElement>('#profileStatus')!;
// ── 站点规则分区 ──
const ruleNameInput = document.querySelector<HTMLInputElement>('#ruleName')!;
const ruleHostInput = document.querySelector<HTMLInputElement>('#ruleHost')!;
const ruleIncludeInput = document.querySelector<HTMLTextAreaElement>('#ruleInclude')!;
const ruleExcludeInput = document.querySelector<HTMLTextAreaElement>('#ruleExclude')!;
const ruleForceInput = document.querySelector<HTMLInputElement>('#ruleForce')!;
const ruleSaveButton = document.querySelector<HTMLButtonElement>('#ruleSave')!;
const ruleEditCancelButton = document.querySelector<HTMLButtonElement>('#ruleEditCancel')!;
const ruleStatus = document.querySelector<HTMLDivElement>('#ruleStatus')!;
const rulePickElement = document.querySelector<HTMLButtonElement>('#rulePickElement')!;
const rulePickHint = document.querySelector<HTMLDivElement>('#rulePickHint')!;
const ruleList = document.querySelector<HTMLDivElement>('#ruleList')!;
const ruleEmpty = document.querySelector<HTMLDivElement>('#ruleEmpty')!;
const ruleSubUrlInput = document.querySelector<HTMLInputElement>('#ruleSubUrl')!;
const ruleSubAddButton = document.querySelector<HTMLButtonElement>('#ruleSubAdd')!;
const ruleSubList = document.querySelector<HTMLDivElement>('#ruleSubList')!;
const ruleSubRefreshButton = document.querySelector<HTMLButtonElement>('#ruleSubRefresh')!;
const ruleSubStatus = document.querySelector<HTMLDivElement>('#ruleSubStatus')!;
const rulePreviewCopyButton = document.querySelector<HTMLButtonElement>('#rulePreviewCopy')!;
const rulePreviewStatus = document.querySelector<HTMLDivElement>('#rulePreviewStatus')!;
const resetAllButton = document.querySelector<HTMLButtonElement>('#resetAll')!;
const openGuideButton = document.querySelector<HTMLButtonElement>('#openGuide')!;
const toggleKeyVisibilityButton = document.querySelector<HTMLButtonElement>('#toggleKeyVisibility')!;
const promptCharCount = document.querySelector<HTMLSpanElement>('#promptCharCount')!;
const toastHost = document.querySelector<HTMLDivElement>('#toastHost')!;
const confirmModal = document.querySelector<HTMLDivElement>('#confirmModal')!;
const modalTitle = document.querySelector<HTMLHeadingElement>('#modalTitle')!;
const modalBody = document.querySelector<HTMLDivElement>('#confirmModal .modal-body')!;
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
const subtitleXEnabledInput = document.querySelector<HTMLInputElement>('#subtitleXEnabled')!;
const subtitleAiSegmentationInput = document.querySelector<HTMLInputElement>('#subtitleAiSegmentation')!;
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

interface ConfirmOptions {
  title: string;
  /** 正文逐行渲染；一律走 textContent，用户数据（服务商名）不会拼进 HTML。 */
  body: string[];
  confirmLabel: string;
}

/** 默认文案：恢复全部默认配置。 */
const DEFAULT_CONFIRM: ConfirmOptions = {
  title: '恢复全部默认配置？',
  body: [
    '此操作将：',
    '• 清除所有 API Key',
    '• 删除服务配置',
    '• 恢复提示词设置',
    '• 恢复译文样式',
    '此操作无法撤销。',
  ],
  confirmLabel: '恢复默认配置',
};

/**
 * 危险操作确认弹窗：Esc 关闭、Tab 焦点陷阱、初始焦点落在「取消」、
 * 点遮罩关闭、关闭后把焦点还给触发元素（Apple HIG 模态可访问性要求）。
 */
const confirmDanger = (options: Partial<ConfirmOptions> = {}): Promise<boolean> =>
  new Promise((resolve) => {
    const config: ConfirmOptions = { ...DEFAULT_CONFIRM, ...options };
    const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    modalTitle.textContent = config.title;
    modalBody.replaceChildren(
      ...config.body.map((line) => {
        const paragraph = document.createElement('p');
        paragraph.textContent = line;
        paragraph.style.margin = '0 0 6px';
        return paragraph;
      }),
    );
    modalConfirmButton.textContent = config.confirmLabel;
    confirmModal.hidden = false;

    const focusableItems = (): HTMLElement[] =>
      Array.from(confirmModal.querySelectorAll<HTMLElement>('button:not([disabled])'));

    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusableItems();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && confirmModal.contains(active);
      if (event.shiftKey && (!inside || active === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    };

    const onOverlayPointerDown = (event: MouseEvent): void => {
      if (event.target === confirmModal) close(false);
    };

    const close = (result: boolean): void => {
      confirmModal.hidden = true;
      document.removeEventListener('keydown', onKeydown, true);
      confirmModal.removeEventListener('mousedown', onOverlayPointerDown);
      modalCancelButton.removeEventListener('click', onCancel);
      modalConfirmButton.removeEventListener('click', onConfirm);
      restoreFocus?.focus();
      resolve(result);
    };
    const onCancel = (): void => close(false);
    const onConfirm = (): void => close(true);
    modalCancelButton.addEventListener('click', onCancel);
    modalConfirmButton.addEventListener('click', onConfirm);
    confirmModal.addEventListener('mousedown', onOverlayPointerDown);
    document.addEventListener('keydown', onKeydown, true);
    modalCancelButton.focus();
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

/** 悬浮按钮滑杆：值域与 config 合同一致（FLOAT_SIZE 26–48 / FLOAT_OPACITY 0.4–1）。 */
const syncFloatControls = (): void => {
  const size = Math.min(48, Math.max(26, Math.round(Number(floatSizeInput.value) || 32)));
  const opacity = Math.min(1, Math.max(0.4, Number(floatOpacityInput.value) || 0.9));
  const sizeLabel = size + 'px';
  const opacityLabel = Math.round(opacity * 100) + '%';
  floatSizeValue.textContent = sizeLabel;
  floatSizeInput.setAttribute('aria-valuetext', sizeLabel);
  floatOpacityValue.textContent = opacityLabel;
  floatOpacityInput.setAttribute('aria-valuetext', opacityLabel);
  syncRangeFill(floatSizeInput);
  syncRangeFill(floatOpacityInput);
};

let floatSaveTimer: number | undefined;
/** 悬浮球外观防抖自动保存：拖动滑杆即时生效（内容脚本监听 storage.onChanged），落盘合并写。 */
const saveFloatNow = async (): Promise<void> => {
  try {
    const config = await getConfig();
    await saveConfig({
      ...config,
      floatSize: Math.min(48, Math.max(26, Math.round(Number(floatSizeInput.value) || 32))),
      floatOpacity: Math.min(1, Math.max(0.4, Number(floatOpacityInput.value) || 0.9)),
    });
  } catch (error) {
    logger.error('options.float_save.failure', { error });
  }
};
const scheduleFloatSave = (): void => {
  syncFloatControls();
  if (floatSaveTimer !== undefined) window.clearTimeout(floatSaveTimer);
  floatSaveTimer = window.setTimeout(() => {
    floatSaveTimer = undefined;
    void saveFloatNow();
  }, 400);
};
floatSizeInput.addEventListener('input', scheduleFloatSave);
floatOpacityInput.addEventListener('input', scheduleFloatSave);

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
  xEnabled: SubtitleConfig['xEnabled'];
  aiSegmentation: SubtitleConfig['aiSegmentation'];
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
  xEnabled: subtitleXEnabledInput.checked,
  aiSegmentation: subtitleAiSegmentationInput.checked,
});

const subtitleEquals = (a: SubtitleSnapshot, b: SubtitleSnapshot): boolean =>
  a.enabled === b.enabled
  && a.displayMode === b.displayMode
  && a.color === b.color
  && a.strokeColor === b.strokeColor
  && a.fontSize === b.fontSize
  && a.shadowIntensity === b.shadowIntensity
  && a.fontFamily === b.fontFamily
  && a.hideNativeCaptions === b.hideNativeCaptions
  && a.xEnabled === b.xEnabled
  && a.aiSegmentation === b.aiSegmentation;

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
    const fullConfig: SubtitleConfig = { ...snapshot };
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
  subtitleXEnabledInput.checked = stored.xEnabled !== false;
  subtitleAiSegmentationInput.checked = stored.aiSegmentation !== false;
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
  floatSizeInput.value = String(config.floatSize);
  floatOpacityInput.value = String(config.floatOpacity);
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
  syncFloatControls();
  lastSavedTheme = readThemeFromControls();
  applyPreview();

  const promptRadio = promptStyleInputs.find((input) => input.value === config.promptStyle);
  if (promptRadio) promptRadio.checked = true;
  useCustomPromptInput.checked = config.useCustomPrompt;
  customPromptInput.value = config.customPrompt;
  customPromptInput.disabled = !config.useCustomPrompt;
  syncPromptCharCount();
  selectionLookupInput.checked = config.selectionLookupEnabled !== false;
  selectionHoverInput.checked = config.selectionHoverEnabled === true;
  renderGlossaryRows(config.glossary);
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
/** 草稿态快照（纯逻辑层只读它做决策）。 */
const draftState = (): DraftState => ({ ids: draftProviderIds, names: draftProviderNames });

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
  const isNoKeyMt = isKeylessProvider(id);
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
  deleteProviderButton.hidden = !canDeleteProvider(id, currentConfig.providers, draftState());
  // 传统 MT（DeepL / 腾讯）：隐藏模型与推理开关
  modelField.hidden = isMt;
  disableReasoningRow.hidden = isMt;
  // DeepL：显示免费/专业套餐选择；腾讯：显示 SecretKey / Region 与申请指引
  deeplPlanField.hidden = !isDeepl;
  tencentFields.hidden = !isTencent;
  // 微软/谷歌翻译使用内置端点；Ollama 保留接口地址供本机服务配置
  serviceFields.hidden = isMicrosoft || isGoogle;
  apiKeyField.hidden = isNoKeyMt;
  microsoftHint.hidden = !isMicrosoft;
  googleHint.hidden = !isGoogle;
  ollamaHint.hidden = !isOllamaProviderId(id);
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
    const isOllama = isOllamaProviderId(selectedProviderId);
    const isNoKeyMt = isKeylessProvider(selectedProviderId);
    if (!endpointValue || (!isMt && !modelValue) || (!isNoKeyMt && !apiKeyValue)) {
      const message = isOllama
        ? '请填写 Ollama 接口地址与模型名称。'
        : isMt
          ? '请填写接口地址与 API Key（腾讯翻译另需 SecretKey）。'
          : '请填写接口地址、API Key 与模型名称后再保存。';
      setStatus(serviceStatus, message, 'error');
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
      ? {
          apiKey: '',
          endpoint: isOllama ? endpointValue : '',
          ...(isOllama ? { model: modelValue } : {}),
        }
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
    const cleared = afterProviderSaved(draftState(), selectedProviderId);
    draftProviderIds.clear();
    for (const key of cleared.ids) draftProviderIds.add(key);
    draftProviderNames.clear();
    for (const [key, value] of cleared.names) draftProviderNames.set(key, value);
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
  const nextNames = nextDraftNames(draftProviderNames, selectedProviderId, name, currentConfig.providers);
  draftProviderNames.clear();
  for (const [key, value] of nextNames) draftProviderNames.set(key, value);
  providerName.textContent = name || '自定义服务商';
  renderProviderRail();
});

deleteProviderButton.addEventListener('click', () => {
  void (async () => {
    const id = selectedProviderId;
    if (!currentConfig || !isCustomProviderId(id)) return;
    // 决策全部委托纯逻辑层（v0.1.21 的反向守卫教训：判断不可藏在 UI 事件里）
    const copy = deleteConfirmCopy(id, currentConfig.providers, draftState());
    const isDraft = copy.confirmLabel === '放弃';
    const name = resolveProviderName(id, currentConfig.providers, draftState());
    const confirmed = await confirmDanger({ ...copy });
    if (!confirmed) return;

    // 草稿：直接从内存移除并回到内置服务商
    if (isDraft) {
      const cleared = afterDraftRemoved(draftState(), id);
      draftProviderIds.clear();
      for (const key of cleared.ids) draftProviderIds.add(key);
      draftProviderNames.clear();
      for (const [key, value] of cleared.names) draftProviderNames.set(key, value);
      selectedProviderId = 'openai';
      renderProviderRail();
      selectProvider('openai');
      showToast(`已放弃「${name}」`);
      setStatus(serviceStatus, '已放弃未保存的自定义服务商。', 'ok');
      return;
    }

    const base = currentConfig;
    const providers = withoutProvider(base.providers, id);
    const nextProviderId = nextActiveProviderAfterDelete(providers, id, base.providerId);
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
      // 侧栏需要重绘：selectProvider 只切面板，不重建服务商列表（漏掉会让已删项留在列表里）
      renderProviderRail();
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
      const isOllama = isOllamaProviderId(testingFor);
      const isNoKeyMt = isKeylessProvider(testingFor);
      // 微软/谷歌翻译及 Ollama 均可免 API Key；接口地址留空时回退内置默认
      const endpointValue = endpoint.value.trim() || getProviderMeta(testingFor).endpoint;
      const apiKeyValue = effectiveApiKey();
      if (!endpointValue || (!apiKeyValue && !isNoKeyMt) || (isOllama && !model.value.trim())) {
        setStatus(serviceStatus, isOllama ? '请先填写接口地址与模型名称。' : isNoKeyMt ? '无需填写任何字段，直接点击即可测试。' : '请先填写接口地址与 API Key。', 'error');
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
        providerId: fetchFor,
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
  inputTranslateShortcutDisplay.textContent = config.shortcuts.inputTranslate
    ? formatShortcut(config.shortcuts.inputTranslate, isMacPlatform)
    : '设置';
  clearTranslateShortcutButton.hidden = !config.shortcuts.translate;
  clearRestoreShortcutButton.hidden = !config.shortcuts.restore;
  lookupShortcutDisplay.textContent = config.shortcuts.lookup
    ? formatShortcut(config.shortcuts.lookup, isMacPlatform)
    : '设置';
  clearInputTranslateShortcutButton.hidden = !config.shortcuts.inputTranslate;
  clearLookupShortcutButton.hidden = !config.shortcuts.lookup;
};

const beginShortcutRecording = async (
  target: ShortcutTarget,
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

const clearShortcut = async (target: ShortcutTarget): Promise<void> => {
  const config = await getConfig();
  await saveConfig({ ...config, shortcuts: { ...config.shortcuts, [target]: '' } });
  syncShortcutRows({ ...config, shortcuts: { ...config.shortcuts, [target]: '' } });
  showToast(target === 'translate' ? '已清除翻译快捷键' : '已清除还原快捷键');
};

const attachShortcutRecording = (target: ShortcutTarget, displayEl: HTMLElement): void => {
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
attachShortcutRecording('inputTranslate', inputTranslateShortcutDisplay);
attachShortcutRecording('lookup', lookupShortcutDisplay);
clearTranslateShortcutButton.addEventListener('click', () => {
  void clearShortcut('translate');
});
clearRestoreShortcutButton.addEventListener('click', () => {
  void clearShortcut('restore');
});
clearInputTranslateShortcutButton.addEventListener('click', () => {
  void clearShortcut('inputTranslate');
});
clearLookupShortcutButton.addEventListener('click', () => {
  void clearShortcut('lookup');
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

// ── 划词查词开关：显式保存 + 回读校验（与提示词同模式） ──
selectionHoverInput.addEventListener('change', () => {
  void (async () => {
    try {
      const config = await getConfig();
      await saveConfig({ ...config, selectionHoverEnabled: selectionHoverInput.checked });
      const verified = await getConfig();
      selectionHoverInput.checked = verified.selectionHoverEnabled === true;
      logger.info('options.selection_hover.toggle', { enabled: selectionHoverInput.checked });
    } catch (error) {
      logger.error('options.selection_hover.failure', { error });
      showToast('保存失败', 'error');
    }
  })();
});

selectionLookupInput.addEventListener('change', () => {
  void (async () => {
    try {
      const config = await getConfig();
      await saveConfig({ ...config, selectionLookupEnabled: selectionLookupInput.checked });
      const verified = await getConfig();
      selectionLookupInput.checked = verified.selectionLookupEnabled !== false;
      logger.info('options.selection_lookup.toggle', { enabled: verified.selectionLookupEnabled !== false });
    } catch (error) {
      logger.error('options.selection_lookup.failure', { error });
      showToast('保存失败', 'error');
    }
  })();
});

// ── 术语表：行编辑 + 防抖自动保存 + JSON 导入导出 ──
let glossarySaveTimer: number | undefined;

const scheduleGlossarySave = (): void => {
  if (glossarySaveTimer !== undefined) window.clearTimeout(glossarySaveTimer);
  glossarySaveTimer = window.setTimeout(() => {
    glossarySaveTimer = undefined;
    void saveGlossaryNow();
  }, 600);
};

const buildGlossaryRow = (entry: GlossaryEntry): HTMLElement => {
  const row = document.createElement('div');
  row.className = 'glossary-row';
  const termInput = document.createElement('input');
  termInput.type = 'text';
  termInput.className = 'glossary-term';
  termInput.placeholder = '原词';
  termInput.maxLength = 80;
  termInput.value = entry.term;
  const arrow = document.createElement('span');
  arrow.className = 'glossary-arrow';
  arrow.textContent = '→';
  const translationInput = document.createElement('input');
  translationInput.type = 'text';
  translationInput.className = 'glossary-translation';
  translationInput.placeholder = '固定译名';
  translationInput.maxLength = 80;
  translationInput.value = entry.translation;
  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'btn-ghost-sm glossary-remove';
  removeButton.title = '删除该术语';
  removeButton.textContent = '✕';
  removeButton.addEventListener('click', () => {
    row.remove();
    scheduleGlossarySave();
  });
  termInput.addEventListener('input', scheduleGlossarySave);
  translationInput.addEventListener('input', scheduleGlossarySave);
  row.append(termInput, arrow, translationInput, removeButton);
  return row;
};

const collectGlossary = (): GlossaryEntry[] =>
  sanitizeGlossary(
    Array.from(glossaryRows.querySelectorAll<HTMLDivElement>('.glossary-row')).map((row) => ({
      term: row.querySelector<HTMLInputElement>('.glossary-term')!.value,
      translation: row.querySelector<HTMLInputElement>('.glossary-translation')!.value,
    })),
  );

const saveGlossaryNow = async (): Promise<void> => {
  try {
    const glossary = collectGlossary();
    const config = await getConfig();
    await saveConfig({ ...config, glossary });
    const verified = await getConfig();
    if (
      verified.glossary.length !== glossary.length
      || verified.glossary.some((entry, i) => entry.term !== glossary[i]?.term || entry.translation !== glossary[i]?.translation)
    ) {
      setStatus(glossaryStatus, '保存未生效，请重试。', 'error');
      return;
    }
    setStatus(glossaryStatus, glossary.length > 0 ? `已保存 ${glossary.length} 条术语。` : '术语表为空。', 'ok');
  } catch (error) {
    logger.error('options.glossary_save.failure', { error });
    setStatus(glossaryStatus, error instanceof Error ? error.message : '术语表保存失败。', 'error');
  }
};

const renderGlossaryRows = (entries: readonly GlossaryEntry[]): void => {
  glossaryRows.textContent = '';
  for (const entry of entries) glossaryRows.append(buildGlossaryRow(entry));
};

glossaryAddButton.addEventListener('click', () => {
  const row = buildGlossaryRow({ term: '', translation: '' });
  glossaryRows.append(row);
  row.querySelector<HTMLInputElement>('.glossary-term')?.focus();
});
glossaryExportButton.addEventListener('click', () => {
  const entries = collectGlossary();
  const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'moyi-glossary.json';
  anchor.click();
  URL.revokeObjectURL(url);
  setStatus(glossaryStatus, `已导出 ${entries.length} 条术语。`, 'ok');
});
glossaryImportButton.addEventListener('click', () => glossaryFileInput.click());
glossaryFileInput.addEventListener('change', () => {
  const file = glossaryFileInput.files?.[0];
  glossaryFileInput.value = '';
  if (!file) return;
  void (async () => {
    try {
      const entries = sanitizeGlossary(JSON.parse(await file.text()));
      if (entries.length === 0) {
        setStatus(glossaryStatus, '文件中没有可识别的术语（需为 [{ term, translation }] 数组）。', 'error');
        return;
      }
      renderGlossaryRows(entries);
      await saveGlossaryNow();
      showToast(`已导入 ${entries.length} 条术语`);
    } catch {
      logger.error('options.glossary_import.failure', {});
      setStatus(glossaryStatus, '导入失败：不是有效的 JSON 词表。', 'error');
    }
  })();
});

const closeGlossaryPaste = (): void => {
  glossaryPasteBox.hidden = true;
  glossaryPasteInput.value = '';
};

glossaryPasteButton.addEventListener('click', () => {
  glossaryPasteBox.hidden = !glossaryPasteBox.hidden;
  if (!glossaryPasteBox.hidden) glossaryPasteInput.focus();
});
glossaryPasteCancelButton.addEventListener('click', closeGlossaryPaste);
glossaryPasteApplyButton.addEventListener('click', () => {
  const parsed = parseGlossaryText(glossaryPasteInput.value);
  if (parsed.length === 0) {
    setStatus(glossaryStatus, '没有解析出可用条目：每行需要「原词 + 分隔符 + 译名」（→ , | 制表符均可），或直接粘贴 JSON。', 'error');
    return;
  }
  // 追加语义：既有项在前，sanitize 按原词去重时保留先出现者 → 冲突以已有译名为准
  const before = collectGlossary();
  const merged = sanitizeGlossary([...before, ...parsed]);
  renderGlossaryRows(merged);
  closeGlossaryPaste();
  void saveGlossaryNow();
  const added = merged.length - before.length;
  const duplicated = parsed.length - Math.max(added, 0);
  showToast(`已导入 ${added} 条${duplicated > 0 ? `，${duplicated} 条重名已跳过` : ''}`);
});

// ── 生词本：列表 / 搜索 / 删除 / 清空 / 导出 ──
let vocabEntries: VocabEntry[] = [];

const downloadVocabFile = (content: string, filename: string, type: string): void => {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};

const renderVocabList = (): void => {
  const needle = vocabSearch.value.trim().toLowerCase();
  const filtered = needle
    ? vocabEntries.filter((entry) => `${entry.word}\n${entry.translation}\n${entry.context}\n${entry.pageTitle}`.toLowerCase().includes(needle))
    : vocabEntries;
  vocabList.textContent = '';
  vocabEmpty.hidden = filtered.length > 0;
  // 新收藏在上看：复习动线从最近开始
  const ordered = [...filtered].sort((a, b) => b.createdAt - a.createdAt);
  for (const entry of ordered) {
    const row = document.createElement('div');
    row.className = 'vocab-row';
    const main = document.createElement('div');
    main.className = 'vocab-main';
    const word = document.createElement('div');
    word.className = 'vocab-word';
    word.textContent = entry.word;
    main.append(word);
    if (entry.translation) {
      const translation = document.createElement('div');
      translation.className = 'vocab-translation';
      translation.textContent = entry.translation;
      main.append(translation);
    }
    if (entry.context) {
      const context = document.createElement('div');
      context.className = 'vocab-context';
      context.textContent = entry.context;
      main.append(context);
    }
    const source = document.createElement('div');
    source.className = 'vocab-source';
    source.textContent = [entry.pageTitle, formatVocabDate(entry.createdAt)].filter(Boolean).join(' · ');
    source.title = entry.url;
    main.append(source);
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'btn-ghost-sm';
    removeButton.title = '删除该生词';
    removeButton.textContent = '✕';
    removeButton.addEventListener('click', () => {
      void (async () => {
        try {
          await saveVocabBook(vocabEntries.filter((item) => item !== entry));
          vocabEntries = await loadVocabBook();
          renderVocabList();
          setStatus(vocabStatus, `已删除「${entry.word}」。`, 'ok');
        } catch (error) {
          logger.error('options.vocab_delete.failure', { error });
          setStatus(vocabStatus, '删除失败，请重试。', 'error');
        }
      })();
    });
    row.append(main, removeButton);
    vocabList.append(row);
  }
};

const refreshVocabBook = async (): Promise<void> => {
  try {
    vocabEntries = await loadVocabBook();
    renderVocabList();
  } catch (error) {
    logger.error('options.vocab_load.failure', { error });
  }
};

vocabSearch.addEventListener('input', renderVocabList);
vocabExportCsvButton.addEventListener('click', () => {
  downloadVocabFile(toVocabCsv(vocabEntries), 'moyi-vocabbook.csv', 'text/csv;charset=utf-8');
  setStatus(vocabStatus, `已导出 ${vocabEntries.length} 条生词（CSV，Excel/WPS 可直接打开）。`, 'ok');
});
vocabExportJsonButton.addEventListener('click', () => {
  downloadVocabFile(toVocabJson(vocabEntries), 'moyi-vocabbook.json', 'application/json');
  setStatus(vocabStatus, `已导出 ${vocabEntries.length} 条生词（JSON）。`, 'ok');
});
vocabClearButton.addEventListener('click', () => {
  void (async () => {
    if (vocabEntries.length === 0) return;
    if (!(await confirmDanger({ title: '清空生词本？', body: [`将删除全部 ${vocabEntries.length} 条生词。`, '此操作无法撤销。'], confirmLabel: '清空' }))) return;
    try {
      await saveVocabBook([]);
      vocabEntries = [];
      renderVocabList();
      setStatus(vocabStatus, '生词本已清空。', 'ok');
    } catch (error) {
      logger.error('options.vocab_clear.failure', { error });
      setStatus(vocabStatus, '清空失败，请重试。', 'error');
    }
  })();
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes['moyi-vocabbook']) void refreshVocabBook();
});
void refreshVocabBook();

// ── 备份与同步：备份/历史/WebDAV/场景 Profile ──
const saveConfigAndReload = async (mutate: (config: Awaited<ReturnType<typeof getConfig>>) => Awaited<ReturnType<typeof getConfig>>): Promise<void> => {
  const config = await getConfig();
  await saveConfig(mutate(config));
  // 跨分区联动（服务商面板、预览、控件回读）统一走整页刷新——与「恢复出厂」同一收口策略
  window.location.reload();
};

const importBackupText = (text: string): void => {
  void (async () => {
    try {
      const parsed = parseConfigBackup(text);
      if (parsed.error || !parsed.snapshot) {
        setStatus(configBackupStatus, parsed.error ?? '备份内容为空。', 'error');
        return;
      }
      await saveConfigAndReload((config) => ({
        ...mergeSnapshot(config, parsed.snapshot as Partial<Awaited<ReturnType<typeof getConfig>>>) as Awaited<ReturnType<typeof getConfig>>,
        configHistory: pushConfigHistory(config.configHistory, config, '导入备份前'),
      }));
    } catch (error) {
      logger.error('options.config_import.failure', { error });
      setStatus(configBackupStatus, '导入失败：保存配置时出错。', 'error');
    }
  })();
};

configExportButton.addEventListener('click', () => {
  void (async () => {
    const config = await getConfig();
    const blob = new Blob([serializeConfigBackup(config)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'moyi-config.json';
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus(configBackupStatus, '备份已导出（不含 API Key）。', 'ok');
  })();
});
configImportButton.addEventListener('click', () => configFileInput.click());
configFileInput.addEventListener('change', () => {
  const file = configFileInput.files?.[0];
  configFileInput.value = '';
  if (!file) return;
  void file.text().then(importBackupText);
});

const renderConfigHistory = (history: readonly ConfigHistoryEntry[]): void => {
  configHistoryList.textContent = '';
  configHistoryEmpty.hidden = history.length > 0;
  for (const entry of history) {
    const row = document.createElement('div');
    row.className = 'profile-row';
    const main = document.createElement('div');
    main.className = 'profile-main';
    const label = document.createElement('div');
    label.className = 'profile-name';
    label.textContent = entry.label;
    const time = document.createElement('div');
    time.className = 'profile-sub';
    time.textContent = new Date(entry.at).toLocaleString();
    main.append(label, time);
    const restore = document.createElement('button');
    restore.className = 'btn-small';
    restore.type = 'button';
    restore.textContent = '恢复';
    restore.addEventListener('click', () => {
      void saveConfigAndReload((config) => ({
        ...mergeSnapshot(config, entry.snapshot) as Awaited<ReturnType<typeof getConfig>>,
        configHistory: pushConfigHistory(config.configHistory, config, '恢复历史前'),
      }));
    });
    row.append(main, restore);
    configHistoryList.append(row);
  }
};

const collectWebDav = (): WebDavSettings => sanitizeWebDavSettings({
  url: webdavUrlInput.value,
  username: webdavUsernameInput.value,
  password: webdavPasswordInput.value,
  path: webdavPathInput.value,
});

/** 先把 WebDAV 表单落盘再执行动作：跨会话可用，也保证失败后配置不丢。 */
const withWebDav = (label: string, action: (settings: WebDavSettings) => Promise<string>): void => {
  void (async () => {
    try {
      const config = await getConfig();
      const settings = collectWebDav();
      await saveConfig({ ...config, webdav: settings });
      const message = await action(settings);
      setStatus(webdavStatus, `${label}：${message}`, 'ok');
    } catch (error) {
      logger.error('options.webdav.failure', { error, label });
      setStatus(webdavStatus, `${label}失败：${error instanceof Error ? error.message : '未知错误'}`, 'error');
    }
  })();
};

webdavTestButton.addEventListener('click', () => {
  withWebDav('测试连接', async (settings) => {
    if (!settings.url || !settings.username) throw new Error('请先填写目录地址与账号。');
    const probe = await webDavProbe(settings);
    return probe.hasBackup ? '连接成功，远端已有备份。' : '连接成功，远端暂无备份。';
  });
});
webdavUploadButton.addEventListener('click', () => {
  withWebDav('上传', async (settings) => {
    if (!settings.url || !settings.username) throw new Error('请先填写目录地址与账号。');
    const config = await getConfig();
    await webDavPut(settings, serializeConfigBackup(config));
    return '备份已上传（不含 API Key）。';
  });
});
webdavDownloadButton.addEventListener('click', () => {
  withWebDav('下载', async (settings) => {
    const text = await webDavGet(settings);
    if (text === null) throw new Error('远端没有备份文件。');
    const parsed = parseConfigBackup(text);
    if (parsed.error || !parsed.snapshot) throw new Error(parsed.error ?? '远端备份内容不可用。');
    await saveConfigAndReload((config) => ({
      ...mergeSnapshot(config, parsed.snapshot as Partial<Awaited<ReturnType<typeof getConfig>>>) as Awaited<ReturnType<typeof getConfig>>,
      configHistory: pushConfigHistory(config.configHistory, config, 'WebDAV 下载前'),
    }));
    return '已应用远端配置。';
  });
});

const renderProfiles = (profiles: readonly SceneProfile[]): void => {
  profileList.textContent = '';
  profileEmpty.hidden = profiles.length > 0;
  for (const profile of profiles) {
    const row = document.createElement('div');
    row.className = 'profile-row';
    const main = document.createElement('div');
    main.className = 'profile-main';
    const name = document.createElement('div');
    name.className = 'profile-name';
    name.textContent = profile.name;
    const sub = document.createElement('div');
    sub.className = 'profile-sub';
    const styleLabel = PROMPT_STYLES.find((style) => style.id === profile.snapshot.promptStyle)?.label ?? '通用';
    sub.textContent = `${getProviderDisplayName(undefined, profile.snapshot.providerId)} · ${styleLabel} · ${profile.snapshot.translationStyle}`;
    main.append(name, sub);
    const actions = document.createElement('span');
    actions.className = 'profile-actions';
    const applyButton = document.createElement('button');
    applyButton.className = 'btn-small';
    applyButton.type = 'button';
    applyButton.textContent = '应用';
    applyButton.addEventListener('click', () => {
      void saveConfigAndReload((config) => ({
        ...applyProfile(config, profile),
        configHistory: pushConfigHistory(config.configHistory, config, '切换场景前'),
      }));
    });
    const deleteButton = document.createElement('button');
    deleteButton.className = 'btn-small';
    deleteButton.type = 'button';
    deleteButton.textContent = '删除';
    deleteButton.addEventListener('click', () => {
      void (async () => {
        const config = await getConfig();
        await saveConfig({ ...config, profiles: config.profiles.filter((item) => item.id !== profile.id) });
        renderProfiles((await getConfig()).profiles);
        setStatus(profileStatus, `已删除场景「${profile.name}」。`, 'ok');
      })();
    });
    actions.append(applyButton, deleteButton);
    row.append(main, actions);
    profileList.append(row);
  }
};

profileSaveButton.addEventListener('click', () => {
  void (async () => {
    const name = profileNameInput.value.trim();
    if (!name) {
      setStatus(profileStatus, '请先给场景起个名字。', 'error');
      return;
    }
    try {
      const config = await getConfig();
      if (config.profiles.length >= PROFILES_MAX) {
        setStatus(profileStatus, `场景数量已达上限（${PROFILES_MAX}），先删一个再保存。`, 'error');
        return;
      }
      const profile: SceneProfile = {
        id: crypto.randomUUID ? crypto.randomUUID() : `p-${Date.now()}`,
        name,
        snapshot: buildProfileSnapshot(config),
      };
      const profiles = sanitizeProfiles([...config.profiles, profile]);
      await saveConfig({ ...config, profiles });
      profileNameInput.value = '';
      renderProfiles(profiles);
      setStatus(profileStatus, `已保存场景「${name}」。`, 'ok');
    } catch (error) {
      logger.error('options.profile_save.failure', { error });
      setStatus(profileStatus, '保存场景失败。', 'error');
    }
  })();
});

void (async () => {
  const config = await getConfig();
  webdavUrlInput.value = config.webdav.url;
  webdavUsernameInput.value = config.webdav.username;
  webdavPasswordInput.value = config.webdav.password;
  webdavPathInput.value = config.webdav.path;
  renderConfigHistory(config.configHistory);
  renderProfiles(config.profiles);
})();

// ── 朗读（TTS v1）：语速/音色 + 试听 ──
const ttsRateInput = document.querySelector<HTMLInputElement>('#ttsRate')!;
const ttsRateValue = document.querySelector<HTMLSpanElement>('#ttsRateValue')!;
const ttsVoiceSelect = document.querySelector<HTMLSelectElement>('#ttsVoice')!;
const ttsVoiceHint = document.querySelector<HTMLDivElement>('#ttsVoiceHint')!;
const ttsReloadVoicesButton = document.querySelector<HTMLButtonElement>('#ttsReloadVoices')!;
const ttsPreviewButton = document.querySelector<HTMLButtonElement>('#ttsPreview')!;
const ttsStatus = document.querySelector<HTMLDivElement>('#ttsStatus')!;
const ttsEdgeEnabled = document.querySelector<HTMLInputElement>('#ttsEdgeEnabled')!;
const ttsEdgePanel = document.querySelector<HTMLDivElement>('#ttsEdgePanel')!;
const ttsEdgeVoiceSelect = document.querySelector<HTMLSelectElement>('#ttsEdgeVoice')!;
const ttsEdgeHint = document.querySelector<HTMLDivElement>('#ttsEdgeHint')!;

const syncTtsRate = (): void => {
  const rate = Math.min(2, Math.max(0.5, Number(ttsRateInput.value) || 1));
  const label = rate.toFixed(1) + '×';
  ttsRateValue.textContent = label;
  ttsRateInput.setAttribute('aria-valuetext', label);
  syncRangeFill(ttsRateInput);
};

const saveTtsNow = async (): Promise<void> => {
  try {
    const config = await getConfig();
    await saveConfig({
      ...config,
      ttsRate: Math.min(2, Math.max(0.5, Number(ttsRateInput.value) || 1)),
      ttsVoiceURI: ttsVoiceSelect.value,
    });
  } catch (error) {
    logger.error('options.tts_save.failure', { error });
  }
};

/** 音色列表：Chrome 异步填充 voices，options 加载时可能为空；onchange/focus 重拉。 */
const refreshTtsVoices = (): void => {
  const voices = typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices() : [];
  const previous = ttsVoiceSelect.value;
  ttsVoiceSelect.textContent = '';
  const autoOption = document.createElement('option');
  autoOption.value = '';
  autoOption.textContent = '自动（按语言挑选系统音色）';
  ttsVoiceSelect.append(autoOption);
  for (const voice of voices) {
    const option = document.createElement('option');
    option.value = voice.voiceURI;
    option.textContent = `${voice.name}（${voice.lang}）`;
    ttsVoiceSelect.append(option);
  }
  ttsVoiceSelect.value = voices.some((voice) => voice.voiceURI === previous) ? previous : '';
  if (voices.length === 0) {
    ttsVoiceHint.textContent = '暂未读到系统音色：请确认系统安装了语音包，然后点「重新加载音色」。';
  } else {
    ttsVoiceHint.textContent = `检测到 ${voices.length} 个系统音色。`;
  }
};

ttsRateInput.addEventListener('input', () => {
  syncTtsRate();
  void saveTtsNow();
});
ttsVoiceSelect.addEventListener('change', () => {
  void saveTtsNow();
  setStatus(ttsStatus, '音色已保存。', 'ok');
});
ttsReloadVoicesButton.addEventListener('click', () => {
  refreshTtsVoices();
  setStatus(ttsStatus, '音色列表已重新加载。', 'ok');
});
ttsPreviewButton.addEventListener('click', () => {
  void (async () => {
    if (typeof speechSynthesis === 'undefined') {
      setStatus(ttsStatus, '当前环境不支持语音合成。', 'error');
      return;
    }
    const config = await getConfig();
    const sample = '这是墨译的朗读示例，The reading voice follows your system settings.';
    const targetLang = resolveTargetSpeechLang(config.targetLanguage) ?? undefined;
    createTtsQueue().speak(sample, { ...(targetLang ? { lang: targetLang } : {}), voiceURI: ttsVoiceSelect.value, rate: Number(ttsRateInput.value) || 1 });
    setStatus(ttsStatus, '正在试听…', 'ok');
  })();
});
// ── Edge 云端语音（可选音源）：开关 + 音色列表（后台拉取）──
let ttsEdgeVoices: { ShortName: string; Gender?: string; Locale?: string }[] = [];

const applyTtsEdgePanel = (): void => {
  ttsEdgePanel.hidden = !ttsEdgeEnabled.checked;
};

const loadTtsEdgeVoices = async (): Promise<void> => {
  ttsEdgeHint.textContent = '正在拉取云端音色…';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'edge-tts-voices' }) as
      { ok: boolean; voices?: { ShortName: string; Gender?: string; Locale?: string }[]; error?: string };
    if (!response?.ok) throw new Error(response?.error || '音色列表拉取失败。');
    ttsEdgeVoices = response.voices ?? [];
    const config = await getConfig();
    ttsEdgeVoiceSelect.textContent = '';
    for (const voice of ttsEdgeVoices) {
      const option = document.createElement('option');
      option.value = voice.ShortName;
      option.textContent = voice.ShortName + (voice.Gender ? ' · ' + (voice.Gender === 'Female' ? '女声' : '男声') : '');
      ttsEdgeVoiceSelect.append(option);
    }
    ttsEdgeVoiceSelect.value = ttsEdgeVoices.some((v) => v.ShortName === config.ttsEdgeVoice)
      ? config.ttsEdgeVoice
      : (ttsEdgeVoices.find((v) => v.ShortName.startsWith('zh-CN'))?.ShortName ?? ttsEdgeVoices[0]?.ShortName ?? '');
    ttsEdgeHint.textContent = ttsEdgeVoices.length > 0
      ? `已加载 ${ttsEdgeVoices.length} 个云端音色`
      : '音色列表为空：可能是协议变化或网络受限——可继续使用系统语音。';
  } catch (error) {
    ttsEdgeHint.textContent = '音色拉取失败：' + (error instanceof Error ? error.message : '未知错误') + '（朗读会自动回退系统语音）';
  }
};

ttsEdgeEnabled.addEventListener('change', () => {
  applyTtsEdgePanel();
  void (async () => {
    const config = await getConfig();
    await saveConfig({ ...config, ttsSource: ttsEdgeEnabled.checked ? 'edge' : 'system' });
    setStatus(ttsStatus, ttsEdgeEnabled.checked ? '已切换到 Edge 云端语音。' : '已切换回系统语音。', 'ok');
    if (ttsEdgeEnabled.checked && ttsEdgeVoices.length === 0) void loadTtsEdgeVoices();
  })();
});

ttsEdgeVoiceSelect.addEventListener('change', () => {
  void (async () => {
    const config = await getConfig();
    await saveConfig({ ...config, ttsEdgeVoice: ttsEdgeVoiceSelect.value });
    setStatus(ttsStatus, '云端音色已保存。', 'ok');
  })();
});

syncTtsRate();
refreshTtsVoices();
void (async () => {
  const config = await getConfig();
  ttsRateInput.value = String(config.ttsRate);
  syncTtsRate();
  if (config.ttsVoiceURI) ttsVoiceSelect.value = config.ttsVoiceURI;
  ttsEdgeEnabled.checked = config.ttsSource === 'edge';
  applyTtsEdgePanel();
  ttsEdgeVoiceSelect.value = config.ttsEdgeVoice;
  if (config.ttsSource === 'edge') void loadTtsEdgeVoices();
})();

// ── 站点规则：个人规则 CRUD + 订阅仓库管理 ──
let editingRuleId = '';

const selectorsToLines = (selectors: readonly string[]): string => selectors.join('\n');

const renderRuleList = (rules: readonly SiteRule[]): void => {
  ruleList.textContent = '';
  ruleEmpty.hidden = rules.length > 0;
  for (const rule of rules) {
    const row = document.createElement('div');
    row.className = 'profile-row';
    const main = document.createElement('div');
    main.className = 'profile-main';
    const name = document.createElement('div');
    name.className = 'profile-name';
    name.textContent = (rule.enabled ? '' : '［已停用］') + rule.name;
    const sub = document.createElement('div');
    sub.className = 'profile-sub';
    sub.textContent = summarizeRule(rule);
    sub.title = sub.textContent;
    main.append(name, sub);
    const actions = document.createElement('span');
    actions.className = 'profile-actions';
    const toggle = document.createElement('button');
    toggle.className = 'btn-small';
    toggle.type = 'button';
    toggle.textContent = rule.enabled ? '停用' : '启用';
    toggle.addEventListener('click', () => {
      void (async () => {
        const config = await getConfig();
        await saveConfig({
          ...config,
          siteRules: config.siteRules.map((item) => (item.id === rule.id ? { ...item, enabled: !item.enabled } : item)),
        });
        renderRuleList((await getConfig()).siteRules);
      })();
    });
    const edit = document.createElement('button');
    edit.className = 'btn-small';
    edit.type = 'button';
    edit.textContent = '编辑';
    edit.addEventListener('click', () => {
      editingRuleId = rule.id;
      ruleNameInput.value = rule.name;
      ruleHostInput.value = rule.hostPattern;
      ruleIncludeInput.value = selectorsToLines(rule.includeSelectors);
      ruleExcludeInput.value = selectorsToLines(rule.excludeSelectors);
      ruleForceInput.checked = rule.forceInclude;
      ruleEditCancelButton.hidden = false;
      ruleSaveButton.textContent = '更新规则';
      ruleNameInput.focus();
    });
    const remove = document.createElement('button');
    remove.className = 'btn-small';
    remove.type = 'button';
    remove.textContent = '删除';
    remove.addEventListener('click', () => {
      void (async () => {
        const config = await getConfig();
        await saveConfig({ ...config, siteRules: config.siteRules.filter((item) => item.id !== rule.id) });
        if (editingRuleId === rule.id) clearRuleForm();
        renderRuleList((await getConfig()).siteRules);
        setStatus(ruleStatus, '规则已删除。', 'ok');
      })();
    });
    actions.append(toggle, edit, remove);
    row.append(main, actions);
    ruleList.append(row);
  }
};

const clearRuleForm = (): void => {
  editingRuleId = '';
  ruleNameInput.value = '';
  ruleHostInput.value = '';
  ruleIncludeInput.value = '';
  ruleExcludeInput.value = '';
  ruleForceInput.checked = false;
  ruleSaveButton.textContent = '保存规则';
  ruleEditCancelButton.hidden = true;
};

// 拾取：向 background 请求在目标页启动拾取器；结果经瞬时键 storage.onChanged 回填
let rulePickArmed = false;
rulePickElement.addEventListener('click', () => {
  void (async () => {
    rulePickArmed = true;
    rulePickHint.textContent = '正在切换到目标网页拾取…（拾取后回到此页即可看到回填）';
    try {
      const response = await chrome.runtime.sendMessage({ type: 'element-picker-start' }) as
        { ok: boolean; url?: string; error?: string };
      if (!response?.ok) throw new Error(response?.error || '启动拾取失败。');
      rulePickHint.textContent = '拾取模式已开启：到目标网页点击要选取的元素（Esc 退出）。';
    } catch (error) {
      rulePickArmed = false;
      rulePickHint.textContent = '启动失败：' + (error instanceof Error ? error.message : '未知错误');
    }
  })();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[PICKED_ELEMENT_KEY] || !rulePickArmed) return;
  const picked = changes[PICKED_ELEMENT_KEY].newValue as PickedElement | undefined;
  if (!picked?.selector) return;
  rulePickArmed = false;
  if (!ruleNameInput.value.trim()) {
    try {
      ruleNameInput.value = picked.title ? `${picked.title.slice(0, 20)} 拾取` : '拾取规则';
    } catch { /* 标题异常时留空 */ }
  }
  try {
    ruleHostInput.value = new URL(picked.url).hostname;
  } catch { /* 非 http url */ }
  const existing = parseSelectorLines(ruleIncludeInput.value);
  if (!existing.includes(picked.selector)) {
    ruleIncludeInput.value = [...existing, picked.selector].join(String.fromCharCode(10));
    if (!ruleForceInput.checked) ruleForceInput.checked = true;
  }
  rulePickHint.textContent = picked.unique
    ? `已拾取：${picked.label} → ${picked.selector}`
    : `已拾取 ${picked.label}，但该选择器当前不唯一（页面可能有重复结构），建议在下方补充限定。`;
});

ruleSaveButton.addEventListener('click', () => {
  void (async () => {
    const built = buildRuleFromForm({
      name: ruleNameInput.value,
      hostPattern: ruleHostInput.value,
      includeText: ruleIncludeInput.value,
      excludeText: ruleExcludeInput.value,
      forceInclude: ruleForceInput.checked,
    }, editingRuleId || `p-${Date.now()}`);
    if (built.error) {
      setStatus(ruleStatus, built.error === 'empty-rule' ? '请至少填写一个选择器，或勾选「强捞」。' : '请填写规则名称与站点。', 'error');
      return;
    }
    const config = await getConfig();
    const { rules: siteRules, mode, dropped } = applyRuleEdit(config.siteRules, editingRuleId, built.rule);
    await saveConfig({ ...config, siteRules });
    clearRuleForm();
    renderRuleList(siteRules);
    setStatus(
      ruleStatus,
      dropped > 0
        ? `${mode === 'updated' ? '已更新' : '已保存'}（${dropped} 个无效选择器已剔除）。`
        : `${mode === 'updated' ? '规则已更新' : '规则已保存'}，下次翻译生效。`,
      dropped > 0 ? 'error' : 'ok',
    );
  })();
});
ruleEditCancelButton.addEventListener('click', () => {
  clearRuleForm();
  setStatus(ruleStatus, '已取消编辑。', 'ok');
});

const renderRuleSubs = (urls: readonly string[], cache: { rules: readonly SiteRule[]; fetchedAt: number }): void => {
  ruleSubList.textContent = '';
  for (const url of urls) {
    const row = document.createElement('div');
    row.className = 'profile-row';
    const main = document.createElement('div');
    main.className = 'profile-main';
    const name = document.createElement('div');
    name.className = 'profile-name';
    name.textContent = url;
    name.title = url;
    const sub = document.createElement('div');
    sub.className = 'profile-sub';
    sub.textContent = isRuleCacheFresh(cache)
      ? `已缓存 ${cache.rules.length} 条规则 · ${new Date(cache.fetchedAt).toLocaleString()}`
      : '缓存已过期，点「立即更新订阅」';
    main.append(name, sub);
    const remove = document.createElement('button');
    remove.className = 'btn-small';
    remove.type = 'button';
    remove.textContent = '移除';
    remove.addEventListener('click', () => {
      void (async () => {
        const config = await getConfig();
        const ruleSubscriptions = config.ruleSubscriptions.filter((item) => item !== url);
        await saveConfig({ ...config, ruleSubscriptions });
        renderRuleSubs(ruleSubscriptions, await loadRuleCache());
        setStatus(ruleSubStatus, '已移除订阅地址。', 'ok');
      })();
    });
    row.append(main, remove);
    ruleSubList.append(row);
  }
  if (urls.length === 0) {
    setStatus(ruleSubStatus, '未订阅任何仓库。你也可以自己写一份 JSON 放到任意 HTTPS 地址。', 'idle');
  }
};

ruleSubAddButton.addEventListener('click', () => {
  void (async () => {
    const url = ruleSubUrlInput.value.trim();
    const config = await getConfig();
    const merged = sanitizeRuleSubscriptions([...config.ruleSubscriptions, url]);
    if (!merged.includes(url)) {
      setStatus(ruleSubStatus, '地址无效（需 http/https）或订阅数已达上限（5）。', 'error');
      return;
    }
    await saveConfig({ ...config, ruleSubscriptions: merged });
    ruleSubUrlInput.value = '';
    renderRuleSubs(merged, await loadRuleCache());
    setStatus(ruleSubStatus, '订阅已添加，点「立即更新订阅」拉取规则。', 'ok');
  })();
});

ruleSubRefreshButton.addEventListener('click', () => {
  void (async () => {
    const config = await getConfig();
    if (config.ruleSubscriptions.length === 0) {
      setStatus(ruleSubStatus, '先添加至少一个仓库地址。', 'error');
      return;
    }
    setStatus(ruleSubStatus, '拉取中…', 'idle');
    const results: { url: string; rules?: SiteRule[]; error?: string }[] = [];
    for (const url of config.ruleSubscriptions) {
      try {
        const response = await chrome.runtime.sendMessage({ type: 'fetch-rule-repository', url }) as
          { ok: boolean; rules?: SiteRule[]; error?: string };
        results.push(response?.ok && response.rules ? { url, rules: response.rules } : { url, error: response?.error || '未知错误' });
      } catch (error) {
        results.push({ url, error: error instanceof Error ? error.message : '未知错误' });
      }
    }
    const merge = mergeSubscriptionResults(results);
    if (merge.shouldWriteCache) await saveRuleCache({ rules: merge.rules, fetchedAt: Date.now() });
    const shown = merge.rules.length > 0 ? { rules: merge.rules, fetchedAt: Date.now() } : await loadRuleCache();
    renderRuleSubs(config.ruleSubscriptions, shown);
    if (merge.success) {
      setStatus(ruleSubStatus, `已更新：${merge.rules.length} 条规则入库（缓存 24 小时）。`, 'ok');
      showToast('规则订阅已更新');
    } else {
      setStatus(ruleSubStatus, `部分失败（${merge.failures.length}/${config.ruleSubscriptions.length}）——${merge.failures[0]?.url}：${merge.failures[0]?.error}`, 'error');
    }
  })();
});

rulePreviewCopyButton.addEventListener('click', () => {
  const command = "document.dispatchEvent(new CustomEvent('moyi:preview-site-rules'))";
  void navigator.clipboard?.writeText(command).then(
    () => setStatus(rulePreviewStatus, '已复制，去目标网页控制台粘贴执行。', 'ok'),
    () => setStatus(rulePreviewStatus, '复制失败，请手动选中复制。', 'error'),
  );
});

void (async () => {
  const config = await getConfig();
  renderRuleList(config.siteRules);
  renderRuleSubs(config.ruleSubscriptions, await loadRuleCache());
})();

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
// 分区清单从 DOM 推导而非硬编码 id 列表：新增分区漏登记 = 菜单点了是空白页
// （本项目踩过一次：生词本/备份与同步/站点规则三个分区同时空白）。
const sections = Array.from(document.querySelectorAll<HTMLElement>('section.group[id]'));
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
    subtitleXEnabledInput.checked = DEFAULT_SUBTITLE_CONFIG.xEnabled;
    subtitleAiSegmentationInput.checked = DEFAULT_SUBTITLE_CONFIG.aiSegmentation;
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
