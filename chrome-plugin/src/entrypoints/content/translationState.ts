import type { ElementTypography } from '../../translation-core/typography';

export type TranslationPhase = 'loading' | 'translated' | 'error';

export interface TranslationState {
  generation: number;
  phase: TranslationPhase;
  sourceText: string;
  /** 采集自原文候选元素的排版快照，用于派生译文内联样式。 */
  typography: ElementTypography;
  translatedNode?: HTMLElement;
  errorNode?: HTMLElement;
  /** 替换模式下承载原文内容的隐藏包装节点，恢复时解包还原。 */
  originalWrapper?: HTMLElement;
}

const states = new WeakMap<HTMLElement, TranslationState>();
const activeElements = new Set<HTMLElement>();

export const getTranslationState = (element: HTMLElement): TranslationState | undefined => states.get(element);

export const beginTranslation = (element: HTMLElement, sourceText: string, typography: ElementTypography): TranslationState => {
  const previous = states.get(element);
  const state: TranslationState = {
    generation: (previous?.generation ?? 0) + 1,
    phase: 'loading',
    sourceText,
    typography,
    // 保留旧 attempt 已插入的节点引用，新渲染可先清理再挂载
    translatedNode: previous?.translatedNode,
    errorNode: previous?.errorNode,
    originalWrapper: previous?.originalWrapper,
  };
  states.set(element, state);
  activeElements.add(element);
  return state;
};

export const updateTranslationState = (element: HTMLElement, patch: Partial<TranslationState>): TranslationState | undefined => {
  const state = states.get(element);
  if (!state) return undefined;
  Object.assign(state, patch);
  return state;
};

export const removeTranslationState = (element: HTMLElement): void => {
  states.delete(element);
  activeElements.delete(element);
};

export const getActiveElements = (): HTMLElement[] => [...activeElements];
