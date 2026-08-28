import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TRANSLATION_THEME,
  applyTranslationStyles,
  renderPartialTranslation,
  renderTranslation,
  renderTranslationError,
  restoreTranslation,
  toTranslationTheme,
} from '../chrome-plugin/src/entrypoints/content/translationRenderer';
import { beginTranslation, getTranslationState } from '../chrome-plugin/src/entrypoints/content/translationState';
import { captureElementTypography } from '../chrome-plugin/src/translation-core/typography';

describe('translation renderer', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    applyTranslationStyles(DEFAULT_TRANSLATION_THEME);
  });

  const mountCandidate = (): { element: HTMLElement; generation: number; snapshot: ReturnType<typeof captureElementTypography> } => {
    const element = document.createElement('p');
    element.style.cssText = 'font-size: 16px; line-height: 1.5;';
    element.textContent = 'The ink flows gently across the paper.';
    document.body.appendChild(element);
    const snapshot = captureElementTypography(element);
    const state = beginTranslation(element, element.textContent ?? '', snapshot);
    return { element, generation: state.generation, snapshot };
  };

  it('renders translation as a child of the candidate with px font size and block-start gap', () => {
    const { element, generation, snapshot } = mountCandidate();
    const ok = renderTranslation(element, '墨迹在纸上轻轻流淌。', generation, snapshot);

    expect(ok).toBe(true);
    const node = element.querySelector('.personal-translator-translation');
    expect(node).not.toBeNull();
    expect(node?.parentElement).toBe(element);
    expect(node?.textContent).toBe('墨迹在纸上轻轻流淌。');
    expect(node?.getAttribute('lang')).toBe('zh-CN');
    expect(node?.getAttribute('data-personal-translator-owned')).toBe('true');
    expect(node?.getAttribute('style')).toContain('font-size: 14.72px');
    // 行高为单位无关倍率（跟随原文 1.5）：移动端 WebView 字号膨胀下保持几何一致
    expect(node?.getAttribute('style')).toContain('line-height: 1.5');
    expect(node?.getAttribute('style')).toContain('margin-block-start:');
    expect(node?.getAttribute('style')).toContain('text-indent: 0');
    expect(node?.getAttribute('style')).toContain('overflow-wrap: anywhere');
    expect(node?.getAttribute('style')).toContain('color: rgb(63, 74, 86)');
    expect(node?.getAttribute('style')).not.toContain('margin-top');
  });

  it('normalizes inherited white-space so long CJK translations wrap instead of overflowing', () => {
    const element = document.createElement('p');
    element.style.cssText = 'font-size: 16px; line-height: 1.5; white-space: nowrap; text-indent: 2em;';
    element.textContent = 'The ink flows gently across the paper.';
    document.body.appendChild(element);
    const snapshot = captureElementTypography(element);
    const state = beginTranslation(element, element.textContent ?? '', snapshot);
    renderTranslation(element, '这是一段很长的中文译文，用于验证在原文存在 nowrap 换行设置时译文不会因此溢出容器。', state.generation, snapshot);

    const node = element.querySelector('.personal-translator-translation') as HTMLElement;
    const style = node.getAttribute('style') ?? '';
    expect(style).toContain('white-space: normal');
    expect(style).toContain('text-indent: 0');
    expect(style).toContain('overflow-wrap: anywhere');
  });

  it('lightens translation color on dark backgrounds and keeps user color on light ones', () => {
    const darkElement = document.createElement('section');
    darkElement.style.cssText = 'font-size: 16px; line-height: 1.5;';
    darkElement.textContent = 'Dark themed paragraph.';
    document.body.appendChild(darkElement);
    // jsdom 不计算背景色，这里显式注入暗背景亮度（近黑）
    const darkSnapshot = { ...captureElementTypography(darkElement), bgLuminance: 0.03 };
    const darkState = beginTranslation(darkElement, darkElement.textContent ?? '', darkSnapshot);
    renderTranslation(darkElement, '暗色网页译文。', darkState.generation, darkSnapshot);
    const darkNode = darkElement.querySelector('.personal-translator-translation') as HTMLElement;
    const darkStyle = darkNode.getAttribute('style') ?? '';
    expect(darkStyle).not.toContain('rgb(63, 74, 86)');
    expect(darkStyle).toContain('color: rgb(');

    const lightElement = document.createElement('section');
    lightElement.style.cssText = 'font-size: 16px; line-height: 1.5;';
    lightElement.textContent = 'Light themed paragraph.';
    document.body.appendChild(lightElement);
    const lightSnapshot = { ...captureElementTypography(lightElement), bgLuminance: 0.9 };
    const lightState = beginTranslation(lightElement, lightElement.textContent ?? '', lightSnapshot);
    renderTranslation(lightElement, '亮色网页译文。', lightState.generation, lightSnapshot);
    const lightNode = lightElement.querySelector('.personal-translator-translation') as HTMLElement;
    expect(lightNode.getAttribute('style')).toContain('color: rgb(63, 74, 86)');
  });

  it('reuses the existing node on partial update without duplicate insertion', () => {
    const { element, generation, snapshot } = mountCandidate();
    renderTranslation(element, '第一段。', generation, snapshot);
    const first = element.querySelector('.personal-translator-translation');

    renderPartialTranslation(element, '第一段继续。', generation, snapshot);
    const nodes = element.querySelectorAll('.personal-translator-translation');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toBe(first);
    expect(nodes[0].textContent).toBe('第一段继续。');
  });

  it('replaces the node on a new generation render', () => {
    const { element, generation, snapshot } = mountCandidate();
    renderTranslation(element, '旧译文。', generation, snapshot);

    const nextState = beginTranslation(element, 'New source', snapshot);
    const ok = renderTranslation(element, '新译文。', nextState.generation, snapshot);
    expect(ok).toBe(true);
    expect(element.querySelectorAll('.personal-translator-translation')).toHaveLength(1);
    expect(element.querySelector('.personal-translator-translation')?.textContent).toBe('新译文。');
  });

  it('ignores stale renders after restore', () => {
    const { element, generation, snapshot } = mountCandidate();
    restoreTranslation(element);
    const ok = renderTranslation(element, '不应出现。', generation, snapshot);
    expect(ok).toBe(false);
    expect(element.querySelector('.personal-translator-translation')).toBeNull();
  });

  it('renders error nodes without killing the candidate', () => {
    const { element, generation, snapshot } = mountCandidate();
    renderTranslation(element, '正常译文。', generation, snapshot);
    const error = renderTranslationError(element, '模型超时', generation);
    expect(error).toBe(true);
    expect(element.querySelector('.personal-translator-error')?.textContent).toContain('翻译失败：模型超时');
  });

  it('maps config to a sanitized theme', () => {
    const theme = toTranslationTheme({
      translationStyle: 'highlight',
      translationColor: 'red',
      translationFontSize: 9,
    } as never);
    expect(theme.preset).toBe('highlight');
    expect(theme.color).toBe('#3f4a56');
    expect(theme.fontScale).toBe(1.15);
  });

  it('refreshes existing node style when theme changes via applyTranslationStyles', () => {
    const { element, generation, snapshot } = mountCandidate();
    renderTranslation(element, '译文。', generation, snapshot);
    const node = element.querySelector('.personal-translator-translation') as HTMLElement;

    applyTranslationStyles({ ...DEFAULT_TRANSLATION_THEME, fontScale: 1.1, color: '#123456' });
    expect(node.getAttribute('style')).toContain('font-size: 17.6px');
    expect(node.getAttribute('style')).toContain('color: rgb(18, 52, 86)');

    applyTranslationStyles(DEFAULT_TRANSLATION_THEME);
  });

  it('applies user font stack when configured and follows original font otherwise', () => {
    const element = document.createElement('p');
    element.style.cssText = 'font-size: 16px; line-height: 1.5; font-family: Georgia, serif;';
    element.textContent = 'The ink flows gently.';
    document.body.appendChild(element);
    const snapshot = captureElementTypography(element);
    snapshot.fontFamily = 'Georgia, serif';
    const state = beginTranslation(element, element.textContent ?? '', snapshot);

    // 默认（fontFamily=''）：跟随原文字体 → 内联复制快照字体
    renderTranslation(element, '默认跟随。', state.generation, snapshot);
    let node = element.querySelector('.personal-translator-translation') as HTMLElement;
    expect(node.getAttribute('style')).toContain('font-family: Georgia, serif');

    // 配置字体栈：覆盖原文，使用用户选择（系统字体）；jsdom 将单引号序列化为双引号
    applyTranslationStyles({ ...DEFAULT_TRANSLATION_THEME, fontFamily: "'Kaiti SC', 'KaiTi', serif" });
    expect(node.getAttribute('style')).toContain('Kaiti SC');
    expect(node.getAttribute('style')).toContain('KaiTi');
    expect(node.getAttribute('style')).toContain('serif');
    expect(node.getAttribute('style')).not.toContain('Georgia');

    applyTranslationStyles(DEFAULT_TRANSLATION_THEME);
    expect(node.getAttribute('style')).toContain('font-family: Georgia, serif');
  });

  it('applies user line height ratio and letter spacing when configured', () => {
    const element = document.createElement('p');
    element.style.cssText = 'font-size: 16px; line-height: 1.5;';
    element.textContent = 'The ink flows gently.';
    document.body.appendChild(element);
    const snapshot = captureElementTypography(element);
    const state = beginTranslation(element, element.textContent ?? '', snapshot);

    // 默认（0）：跟随原文 → 行高倍率 1.5，无 letter-spacing 覆盖
    renderTranslation(element, '默认。', state.generation, snapshot);
    let node = element.querySelector('.personal-translator-translation') as HTMLElement;
    let style = node.getAttribute('style') ?? '';
    expect(style).toContain('line-height: 1.5');
    expect(style).not.toContain('letter-spacing');

    // 设置行距 1.6、字距 0.05em（倍率写法：随实际渲染字号缩放，移动端字号膨胀下不错乱）
    applyTranslationStyles({ ...DEFAULT_TRANSLATION_THEME, lineHeight: 1.6, letterSpacing: 0.05 });
    style = node.getAttribute('style') ?? '';
    expect(style).toContain('line-height: 1.6');
    expect(style).toContain('letter-spacing: 0.05em');

    applyTranslationStyles(DEFAULT_TRANSLATION_THEME);
    style = node.getAttribute('style') ?? '';
    expect(style).not.toContain('letter-spacing');
  });

  it('keeps getTranslationState typography snapshot for later refresh', () => {
    const { element, generation, snapshot } = mountCandidate();
    renderTranslation(element, '译文。', generation, snapshot);
    expect(getTranslationState(element)?.typography.fontSizePx).toBe(16);
  });

  it('replace preset hides original content behind a wrapper and renders translation in place', () => {
    applyTranslationStyles({ ...DEFAULT_TRANSLATION_THEME, preset: 'replace' });
    const { element, generation, snapshot } = mountCandidate();
    const original = element.firstChild;

    const ok = renderTranslation(element, '译文替换原文。', generation, snapshot);
    expect(ok).toBe(true);
    const wrapper = element.querySelector('.personal-translator-original');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.contains(original)).toBe(true);
    expect(element.querySelector('.personal-translator-translation')?.textContent).toBe('译文替换原文。');

    // 替换模式下译文不叠加原文→译文间距
    const node = element.querySelector('.personal-translator-translation') as HTMLElement;
    expect(node.getAttribute('style')).not.toContain('margin-block-start');
    expect(node.getAttribute('style')).toContain('font-size: 14.72px');

    applyTranslationStyles(DEFAULT_TRANSLATION_THEME);
  });

  it('switching back from replace preset unwraps the original content', () => {
    applyTranslationStyles({ ...DEFAULT_TRANSLATION_THEME, preset: 'replace' });
    const { element, generation, snapshot } = mountCandidate();
    renderTranslation(element, '译文替换原文。', generation, snapshot);
    expect(element.querySelector('.personal-translator-original')).not.toBeNull();

    applyTranslationStyles(DEFAULT_TRANSLATION_THEME);
    expect(element.querySelector('.personal-translator-original')).toBeNull();
    expect(element.textContent).toContain('The ink flows gently across the paper.');
    expect(element.querySelector('.personal-translator-translation')?.textContent).toBe('译文替换原文。');
  });

  it('restore after replace preset returns the original content and removes owned nodes', () => {
    applyTranslationStyles({ ...DEFAULT_TRANSLATION_THEME, preset: 'replace' });
    const { element, generation, snapshot } = mountCandidate();
    renderTranslation(element, '译文替换原文。', generation, snapshot);
    restoreTranslation(element);

    expect(element.querySelector('[data-personal-translator-owned]')).toBeNull();
    expect(element.textContent).toBe('The ink flows gently across the paper.');
  });
});
