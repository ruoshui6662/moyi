import { sanitizeTranslationColor, sanitizeTranslationFontFamily, sanitizeTranslationFontSize, sanitizeTranslationLetterSpacing, sanitizeTranslationLineHeight, sanitizeTranslationStylePreset, type TranslationStylePreset, type TranslatorConfig } from '../../utils/config';
import {
  computeTranslationTypography,
  MIN_TRANSLATION_LINE_HEIGHT,
  toTranslationStyle,
  type ElementTypography,
} from '../../translation-core/typography';
import { resolveReadableColor } from '../../utils/colorReadability';
import { getActiveElements, getTranslationState, removeTranslationState, updateTranslationState } from './translationState';

const TRANSLATION_CLASS = 'personal-translator-translation';
const ERROR_CLASS = 'personal-translator-error';
const ORIGINAL_WRAPPER_CLASS = 'personal-translator-original';
const STYLE_ELEMENT_ID = 'personal-translator-styles';

export interface TranslationTheme {
  preset: TranslationStylePreset;
  color: string;
  /** 用户倍率：译文实际字号 = 候选元素字号 × fontScale。 */
  fontScale: number;
  /** 译文字体栈；空串 = 跟随原文字体。 */
  fontFamily: string;
  /** 译文行高倍率；0 = 跟随原文节奏。 */
  lineHeight: number;
  /** 译文字距（em）；0 = 跟随原文字距。 */
  letterSpacing: number;
}

export const DEFAULT_TRANSLATION_THEME: TranslationTheme = {
  preset: 'ink-line',
  color: '#3f4a56',
  fontScale: 0.92,
  fontFamily: '',
  lineHeight: 0,
  letterSpacing: 0,
};

/** 从配置映射到渲染主题，统一 content 初始化、storage 监听与 Options 预览的入口。 */
export const toTranslationTheme = (config: Pick<TranslatorConfig, 'translationStyle' | 'translationColor' | 'translationFontSize' | 'translationFontFamily' | 'translationLineHeight' | 'translationLetterSpacing'>): TranslationTheme => ({
  preset: sanitizeTranslationStylePreset(config.translationStyle),
  color: sanitizeTranslationColor(config.translationColor),
  fontScale: sanitizeTranslationFontSize(config.translationFontSize),
  fontFamily: sanitizeTranslationFontFamily(config.translationFontFamily),
  lineHeight: sanitizeTranslationLineHeight(config.translationLineHeight),
  letterSpacing: sanitizeTranslationLetterSpacing(config.translationLetterSpacing),
});

/** 判断当前主题是否为「直接替换原文」模式。 */
export const isReplacePreset = (preset: TranslationStylePreset): boolean => preset === 'replace';

/** marker 装饰：仅类样式，几何与文本契约由译文节点内联样式保证。 */
const buildMarkerRules = (preset: TranslationStylePreset): string => {
  switch (preset) {
    case 'ink-line':
      return 'border-inline-start: 2px solid rgba(176, 58, 46, 0.3); padding-inline-start: 0.6em;';
    case 'jade-line':
      return 'border-inline-start: 2px solid rgba(63, 74, 86, 0.35); padding-inline-start: 0.6em;';
    case 'underline':
      return 'border-block-end: 1px dashed rgba(103, 135, 116, 0.55); padding-block-end: 0.15em;';
    case 'highlight':
      return 'background: rgba(226, 238, 241, 0.9); border-radius: 2px; padding-inline: 0.55em; padding-block: 0.2em;';
    default:
      return '';
  }
};

export const buildTranslationCss = (theme: TranslationTheme): string => `
  @keyframes personal-translator-fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  .${TRANSLATION_CLASS} {
    display: block;
    color: ${theme.color};
    box-sizing: border-box;
    /* 移动端 WebView 的字体自动放大（text autosizing / font boosting）会把译文块
       字号膨胀，与显式排版契约冲突导致行重叠；在子树内整体禁用以保几何可控 */
    -webkit-text-size-adjust: none;
    text-size-adjust: none;
    ${buildMarkerRules(theme.preset)}
    animation: personal-translator-fade-in 0.24s ease-out;
  }
  .${ORIGINAL_WRAPPER_CLASS} {
    display: none;
  }
  .${ERROR_CLASS} {
    display: block;
    margin-block-start: 0.35em;
    color: #b03a2e;
    font-size: 0.85em;
  }
  @media (prefers-reduced-motion: reduce) {
    .${TRANSLATION_CLASS}, .${ERROR_CLASS} { animation: none; }
  }
`;

let activeTheme: TranslationTheme = { ...DEFAULT_TRANSLATION_THEME };

/**
 * 生成译文节点的内联样式契约：字号/行高来自原文排版快照与用户倍率，
 * 其余排版属性显式复制，避免页面 CSS 覆盖或继承造成错位。
 * 替换模式下原文已隐藏，不叠加原文→译文间距。
 *
 * 中文/双语排版保障：
 *   - text-indent 置 0：原文若设首行缩进（如 2em），替换模式下隐藏原文后
 *     译文块会成为容器第一个行盒而继承缩进，造成首行错位；
 *   - white-space 安全化：nowrap/pre 会让长中文译文不换行或丢失换行，
 *     统一收敛为 normal / pre-wrap，保证译文正常换行；
 *   - overflow-wrap: anywhere：防止长词/URL/无空格串撑破容器。
 */
const SAFE_WHITE_SPACE = new Set(['pre', 'pre-wrap']);

const buildTranslationInlineStyle = (
  snapshot: ElementTypography,
  fontScale: number,
  color: string,
): Record<string, string> => {
  const { fontSizePx, gapPx } = computeTranslationTypography(snapshot, fontScale);
  const derived = toTranslationStyle(snapshot);
  // 暗色网页（深背景）自动提亮译文颜色，保证可读；亮背景保持用户配置色
  const resolvedColor = resolveReadableColor(color, snapshot.bgLuminance);
  /**
   * 行高必须输出「单位无关倍率」而非 px 值。
   * 根因：移动端 WebView（Via 等）存在字体自动放大（font boosting / text autosizing），
   * 会把无 viewport 或小字号的文本块字号膨胀 ~1.2-1.6×。显式 px 行高不随字号缩放，
   * 一旦引擎放大字号，行盒高度小于字形高度 → 行与行重叠、排版错乱；
   * 桌面端无此机制，故此前未暴露。倍率写法让行高始终跟随实际渲染字号，
   * 在任何字号膨胀下保持几何一致（桌面视觉结果数学等价）。
   */
  const lineHeightRatio = activeTheme.lineHeight > 0
    ? activeTheme.lineHeight
    : Math.max(snapshot.lineHeightRatio, MIN_TRANSLATION_LINE_HEIGHT);
  const styles: Record<string, string> = {
    'font-size': `${fontSizePx}px`,
    'line-height': String(Math.round(lineHeightRatio * 100) / 100),
    color: resolvedColor,
    'text-indent': '0',
    'overflow-wrap': 'anywhere',
  };
  if (!isReplacePreset(activeTheme.preset)) {
    styles['margin-block-start'] = `${gapPx}px`;
  }
  for (const [property, value] of Object.entries(derived)) {
    if (property === 'fontFamily') continue; // 字体统一在下方按「配置 > 原文」决定
    if (property === 'letterSpacing' && activeTheme.letterSpacing !== 0) continue; // 用户字距优先
    if (property === 'whiteSpace') {
      styles['white-space'] = SAFE_WHITE_SPACE.has(value) ? 'pre-wrap' : 'normal';
      continue;
    }
    styles[property] = value;
  }
  // 译文字体：配置非空用用户字体（系统字体栈），为空跟随原文字体
  const fontStack = activeTheme.fontFamily.trim() || derived.fontFamily;
  if (fontStack) styles['font-family'] = fontStack;
  // 用户指定字距（em，随字号缩放）；0 = 跟随原文（含原文 normal）
  if (activeTheme.letterSpacing !== 0) {
    styles['letter-spacing'] = `${activeTheme.letterSpacing}em`;
  }
  return styles;
};

/** 先清空再逐属性写入；setProperty 由浏览器负责值转义，font-family 等用户输入无法混入新声明。 */
const applyInlineStyleMap = (element: HTMLElement, styles: Record<string, string>): void => {
  element.style.cssText = '';
  for (const [property, value] of Object.entries(styles)) {
    element.style.setProperty(property, value);
  }
};

const refreshTranslationNodeStyle = (element: HTMLElement): void => {
  const state = getTranslationState(element);
  if (!state?.translatedNode || !state.translatedNode.isConnected) return;
  applyInlineStyleMap(
    state.translatedNode,
    buildTranslationInlineStyle(
      state.typography,
      activeTheme.fontScale,
      activeTheme.color,
    ),
  );
};

/** 存储变更或主题切换时刷新所有已渲染译文的内联样式（不重放动画）。 */
const refreshActiveTranslationStyles = (): void => {
  for (const element of getActiveElements()) refreshTranslationNodeStyle(element);
};

/**
 * 替换模式：把候选元素的原文直接子节点移入隐藏包装节点，
 * 译文成为元素内唯一可见内容。
 * 只移动原文节点——绝不把已挂载的译文/错误节点一起包进去，
 * 否则从双语切到替换时译文会瞬间消失，还原时也无法恢复原文。
 */
const wrapOriginal = (element: HTMLElement): void => {
  const state = getTranslationState(element);
  if (!state?.originalWrapper?.isConnected) {
    const wrapper = document.createElement('span');
    wrapper.className = ORIGINAL_WRAPPER_CLASS;
    wrapper.dataset.personalTranslatorOwned = 'true';
    while (element.firstChild && element.firstChild !== state?.translatedNode) {
      wrapper.appendChild(element.firstChild);
    }
    element.appendChild(wrapper);
    updateTranslationState(element, { originalWrapper: wrapper });
  }
};

const unwrapOriginal = (element: HTMLElement): void => {
  const state = getTranslationState(element);
  const wrapper = state?.originalWrapper;
  if (!wrapper || !wrapper.isConnected) return;
  const children = Array.from(wrapper.childNodes);
  wrapper.remove();
  const reference = state?.translatedNode?.isConnected ? state.translatedNode : null;
  for (const child of children) element.insertBefore(child, reference);
  updateTranslationState(element, { originalWrapper: undefined });
};

/** 主题切换时在「双语」与「直接替换」之间收敛每个已渲染元素的结构。 */
const reconcileReplaceMode = (): void => {
  const isReplace = isReplacePreset(activeTheme.preset);
  for (const element of getActiveElements()) {
    const state = getTranslationState(element);
    if (!state) continue;
    const hasWrapper = Boolean(state.originalWrapper?.isConnected);
    if (isReplace && !hasWrapper && state.translatedNode?.isConnected) {
      wrapOriginal(element);
    } else if (!isReplace && hasWrapper) {
      unwrapOriginal(element);
    }
  }
};

export const applyTranslationStyles = (theme: TranslationTheme): void => {
  const css = buildTranslationCss(theme);
  let styleElement = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (!styleElement) {
    styleElement = document.createElement('style');
    styleElement.id = STYLE_ELEMENT_ID;
    (document.head || document.documentElement).appendChild(styleElement);
  }
  if (styleElement.textContent !== css) {
    styleElement.textContent = css;
  }
  activeTheme = theme;
  refreshActiveTranslationStyles();
  reconcileReplaceMode();
};

const ensureStyles = (): void => {
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  applyTranslationStyles(activeTheme);
};

const createTranslationNode = (): HTMLSpanElement => {
  const node = document.createElement('span');
  node.className = TRANSLATION_CLASS;
  node.dataset.personalTranslatorOwned = 'true';
  return node;
};

const applyTranslationNode = (
  element: HTMLElement,
  node: HTMLSpanElement,
  snapshot: ElementTypography,
  generation: number,
): boolean => {
  const state = getTranslationState(element);
  if (!state || state.generation !== generation || !element.isConnected) return false;
  ensureStyles();
  state.errorNode?.remove();
  state.translatedNode?.remove();
  if (isReplacePreset(activeTheme.preset)) wrapOriginal(element);
  applyInlineStyleMap(node, buildTranslationInlineStyle(snapshot, activeTheme.fontScale, activeTheme.color));
  element.appendChild(node);
  updateTranslationState(element, { translatedNode: node, typography: snapshot });
  return true;
};

export const renderTranslation = (element: HTMLElement, translation: string, generation: number, snapshot?: ElementTypography): boolean => {
  const state = getTranslationState(element);
  if (!state || state.generation !== generation || !element.isConnected) return false;
  const typography = snapshot ?? state.typography;
  const node = createTranslationNode();
  node.lang = 'zh-CN';
  node.textContent = translation;
  return applyTranslationNode(element, node, typography, generation);
};

export const renderPartialTranslation = (element: HTMLElement, partialText: string, generation: number, snapshot?: ElementTypography): boolean => {
  const state = getTranslationState(element);
  if (!state || state.generation !== generation || !element.isConnected) return false;
  const typography = snapshot ?? state.typography;
  if (state.translatedNode && state.translatedNode.isConnected) {
    applyInlineStyleMap(state.translatedNode, buildTranslationInlineStyle(typography, activeTheme.fontScale, activeTheme.color));
    state.translatedNode.textContent = partialText;
    updateTranslationState(element, { typography });
    return true;
  }
  const node = createTranslationNode();
  node.lang = 'zh-CN';
  node.textContent = partialText;
  return applyTranslationNode(element, node, typography, generation);
};

export const renderTranslationError = (element: HTMLElement, message: string, generation: number): boolean => {
  const state = getTranslationState(element);
  if (!state || state.generation !== generation || !element.isConnected) return false;
  ensureStyles();
  state.translatedNode?.remove();
  unwrapOriginal(element);
  const errorNode = document.createElement('span');
  errorNode.className = ERROR_CLASS;
  errorNode.dataset.personalTranslatorOwned = 'true';
  // 暗色网页上错误提示同样提亮为浅红，保证可见
  errorNode.style.color = resolveReadableColor('#b03a2e', state.typography.bgLuminance);
  errorNode.textContent = `翻译失败：${message}`;
  element.appendChild(errorNode);
  updateTranslationState(element, { phase: 'error', errorNode });
  return true;
};

export const restoreTranslation = (element: HTMLElement): void => {
  const state = getTranslationState(element);
  if (!state) return;
  // 先解包还原原文（此时译文仍在 DOM，作为插入参照），再移除译文
  unwrapOriginal(element);
  state.translatedNode?.remove();
  state.errorNode?.remove();
  removeTranslationState(element);
};
