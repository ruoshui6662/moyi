import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TRANSLATION_THEME,
  applyTranslationStyles,
  renderTranslation,
  restoreTranslation,
} from '../chrome-plugin/src/entrypoints/content/translationRenderer';
import { beginTranslation, getActiveElements } from '../chrome-plugin/src/entrypoints/content/translationState';
import { captureElementTypography } from '../chrome-plugin/src/translation-core/typography';

/**
 * 复刻 content 脚本页面级还原流程（trans.ts restoreAllTranslations 的核心两环）：
 * 1) 对每个活动元素调用 restoreTranslation；
 * 2) 兜底删除所有带 data-personal-translator-owned 的残留节点。
 * 目标：验证「直接替换」模式下还原后原文完整恢复，而不是连同译文一起被清空。
 */
const restoreAllLikeContentScript = (): void => {
  for (const element of getActiveElements()) restoreTranslation(element);
  for (const element of Array.from(document.querySelectorAll<HTMLElement>('[data-personal-translator-owned]'))) element.remove();
};

describe('restore-all in replace preset (page-level)', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    applyTranslationStyles(DEFAULT_TRANSLATION_THEME);
  });

  const mountParagraph = (): { element: HTMLElement; generation: number; snapshot: ReturnType<typeof captureElementTypography> } => {
    const element = document.createElement('p');
    element.style.cssText = 'font-size: 16px; line-height: 1.5;';
    element.textContent = 'The ink flows gently across the paper, carrying meaning.';
    document.body.appendChild(element);
    const snapshot = captureElementTypography(element);
    const state = beginTranslation(element, element.textContent ?? '', snapshot);
    return { element, generation: state.generation, snapshot };
  };

  it('restores the original text after rendering in replace preset then undoing', () => {
    applyTranslationStyles({ ...DEFAULT_TRANSLATION_THEME, preset: 'replace' });
    const { element, generation, snapshot } = mountParagraph();
    renderTranslation(element, '译文替换了原文。', generation, snapshot);

    restoreAllLikeContentScript();

    // 原文必须恢复，且不能残留 owned 节点（包括隐藏包装）
    expect(element.textContent).toBe('The ink flows gently across the paper, carrying meaning.');
    expect(element.querySelector('[data-personal-translator-owned]')).toBeNull();
    expect(element.querySelector('.personal-translator-original')).toBeNull();
    expect(element.querySelector('.personal-translator-translation')).toBeNull();
  });

  it('restores original after rendering in dual-language then switching to replace then undoing', () => {
    // 先在双语/默认样式下渲染（原文不包装，译文作为普通后续节点）
    const { element, generation, snapshot } = mountParagraph();
    renderTranslation(element, '译文在双语模式。', generation, snapshot);
    expect(element.querySelector('.personal-translator-original')).toBeNull();

    // 用户切到「直接替换」：内容脚本触发 applyTranslationStyles → reconcileReplaceMode 包装原文
    applyTranslationStyles({ ...DEFAULT_TRANSLATION_THEME, preset: 'replace' });

    // 切替换后译文必须保持可见，只有原文被隐藏（之前会被一起包进 wrapper 造成整段空白）
    const wrapper = element.querySelector('.personal-translator-original');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.textContent).toContain('The ink flows gently');
    expect(element.querySelector('.personal-translator-translation')?.textContent).toBe('译文在双语模式。');
    expect(element.querySelector('.personal-translator-translation')?.isConnected).toBe(true);

    // 撤销
    restoreAllLikeContentScript();

    expect(element.textContent).toBe('The ink flows gently across the paper, carrying meaning.');
    expect(element.querySelector('[data-personal-translator-owned]')).toBeNull();
  });
});