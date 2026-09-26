/**
 * 输入框翻译浮层与回填（插件独有功能；油猴 import 图不触及）。
 *
 * 触发模型：焦点在可编辑元素 + 应用内快捷键 → 捕获「选中文本，无选区则整篇草稿」→
 * 浮层显示原文并流式显示译文 → 用户点「替换」才写回输入框（绝不自动落笔）。
 *
 * 回填策略（与页面框架的兼容性是核心矛盾）：
 * - input/textarea：原生 `setRangeText` 写入后手动派发 input 事件。
 *   前者保留浏览器撤销栈（Ctrl+Z 整体撤销），后者让 React 等受控组件读到新值；
 *   先设原生值再派发的顺序反了会让受控组件把输入吐回去。
 * - contentEditable：`execCommand('insertText')` 同样保留撤销栈；被禁（返回 false）
 *   时回退到 Range API 手动插入（此路径撤销栈由浏览器决定，尽量优于静默失败）。
 */

import { GLASS_OVERLAY_CSS, OVERLAY_FONT_STACK } from '../../styles/overlayTokens';
import { isEditableTarget } from './selectionCard';

export const INPUT_TRANSLATE_HOST_ID = 'moyi-input-translate';

const PANEL_WIDTH = 360;
const VIEWPORT_MARGIN = 12;

const esc = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const buildPanelMarkup = (): string => `
  <style>
    :host { all: initial; ${GLASS_OVERLAY_CSS} }
    .panel {
      position: fixed;
      z-index: 2147483001;
      box-sizing: border-box;
      width: ${PANEL_WIDTH}px;
      max-width: calc(100vw - ${VIEWPORT_MARGIN * 2}px);
      background: var(--moyi-glass-bg);
      -webkit-backdrop-filter: blur(var(--moyi-glass-blur)) saturate(180%);
      backdrop-filter: blur(var(--moyi-glass-blur)) saturate(180%);
      color: var(--moyi-glass-label);
      border: 1px solid var(--moyi-glass-border);
      border-radius: var(--moyi-glass-radius);
      box-shadow:
        var(--moyi-glass-shadow),
        inset 0 1px 0 var(--moyi-glass-specular);
      font-family: ${OVERLAY_FONT_STACK};
      font-size: 13px;
      line-height: 1.55;
      letter-spacing: -0.006em;
      padding: 13px 15px;
      overflow: hidden;
    }
    .panel::before {
      content: '';
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: linear-gradient(180deg, var(--moyi-glass-sheen), transparent 44%);
    }
    .panel > * { position: relative; }
    .panel[hidden] { display: none; }
    .source { padding-right: 26px;
      color: var(--moyi-glass-label-2); font-size: 12px;
      max-height: 72px; overflow: hidden; text-overflow: ellipsis;
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
    }
    .target { margin-top: 8px; min-height: 20px; white-space: pre-wrap; }
    .target.streaming::after {
      content: '▍'; color: var(--moyi-glass-label-2);
      animation: blink 1s steps(2, start) infinite;
    }
    @keyframes blink { to { visibility: hidden; } }
    .status { color: var(--moyi-glass-danger); }
    .foot { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--moyi-glass-edge); display: flex; gap: 8px; align-items: center; }
    .actions { display: inline-flex; gap: 10px; margin-left: auto; }
    button { background: none; border: none; color: var(--moyi-glass-label-2); font: inherit; font-size: 12px; cursor: pointer; padding: 0 2px; border-radius: 4px; }
    button:hover:not(:disabled) { color: var(--moyi-glass-label); background: rgba(255,255,255,.08); }
    button:disabled { opacity: .5; cursor: default; }
    button.primary { color: var(--moyi-glass-success); font-weight: 600; }
    .hint { color: var(--moyi-glass-label-2); font-size: 11px; }
    .close {
      position: absolute; top: 8px; right: 8px; z-index: 2;
      width: 22px; height: 22px; padding: 0; line-height: 1;
      display: grid; place-items: center; font-size: 11px;
    }
    @media print { .panel { display: none !important; } }
    @media (prefers-reduced-motion: reduce) { .target.streaming::after { animation: none; } }
  </style>
  <div class="panel" hidden role="dialog" aria-label="输入框翻译">
    <button class="close" type="button" title="关闭（Esc）" aria-label="关闭">✕</button>
    <div class="source"></div>
    <div class="target streaming"></div>
    <div class="foot">
      <span class="hint">Esc 关闭 · 不自动改写输入框</span>
      <span class="actions"><button class="copy" type="button">复制</button><button class="insert" type="button" disabled>替换</button></span>
    </div>
  </div>
`;

/** 流式片段里的段落标签（与输出契约一致）不该出现在译文展示中。 */
export const stripParagraphTags = (text: string): string => text.replace(/<\/?paragraph_\d+>/g, '');

/** 取「选中文本，无选区则整篇值」——发帖双语场景两种都要。 */
export const captureInputText = (target: HTMLInputElement | HTMLTextAreaElement): { text: string; start: number; end: number } => {
  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? start;
  const selected = target.value.slice(start, end).trim();
  if (selected) return { text: selected, start, end };
  return { text: target.value.trim(), start: target.value.length, end: target.value.length };
};

/**
 * 回填译文。input/textarea 走 setRangeText（保撤销栈 + 受控组件兼容）；
 * contentEditable 走 execCommand（失败回退 Range API）。返回是否成功。
 */
export const insertTranslation = (target: HTMLElement, text: string, start?: number, end?: number): boolean => {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    const at = start ?? target.selectionStart ?? target.value.length;
    const to = end ?? target.selectionEnd ?? at;
    try {
      target.setRangeText(text, at, to, 'end');
    } catch {
      return false;
    }
    // React 受控组件监听 input 事件读取 DOM 值——必须手动派发
    target.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  if (target.getAttribute('contenteditable') === 'true' || target.getAttribute('contenteditable') === '') {
    if (document.execCommand?.('insertText', false, text)) return true;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;
    const range = selection.getRangeAt(0);
    if (!target.contains(range.commonAncestorContainer)) return false;
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    target.dispatchEvent(new InputEvent('input', { bubbles: true }));
    return true;
  }
  return false;
};

export interface InputTranslateOverlay {
  open(sourceText: string, anchorRect: { top: number; bottom: number; left: number }): void;
  appendDelta(text: string): void;
  finish(translation: string): void;
  showError(message: string): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

export interface InputTranslateOverlayOptions {
  onInsert: (translation: string) => void;
}

/** closed shadow 不可从外部达；模块内登记表供单元测试穿透（floatingButton 同款）。 */
const shadowRoots = new WeakMap<HTMLElement, ShadowRoot>();
/** 仅供单元测试；生产代码禁止使用。 */
export const getInputTranslateShadowForTest = (host: HTMLElement): ShadowRoot | null =>
  shadowRoots.get(host) ?? null;

export const mountInputTranslateOverlay = (options: InputTranslateOverlayOptions): InputTranslateOverlay => {
  if (document.getElementById(INPUT_TRANSLATE_HOST_ID)) {
    throw new Error(`输入框翻译宿主已存在：#${INPUT_TRANSLATE_HOST_ID}`);
  }
  const host = document.createElement('div');
  host.id = INPUT_TRANSLATE_HOST_ID;
  host.style.cssText = 'all: initial; position: static;';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = buildPanelMarkup();
  document.documentElement.appendChild(host);
  shadowRoots.set(host, shadow);
  const panel = shadow.querySelector<HTMLElement>('.panel')!;
  const closeBtn = shadow.querySelector<HTMLButtonElement>('.close')!;
  const source = shadow.querySelector<HTMLElement>('.source')!;
  const target = shadow.querySelector<HTMLElement>('.target')!;
  const insertButton = shadow.querySelector<HTMLButtonElement>('.insert')!;
  const copyButton = shadow.querySelector<HTMLButtonElement>('.copy')!;
  let finalText = '';
  let disposed = false;

  const close = (): void => {
    panel.hidden = true;
    finalText = '';
    target.textContent = '';
    target.classList.add('streaming');
    insertButton.disabled = true;
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || panel.hidden || disposed) return;
    event.stopPropagation();
    close();
  };
  window.addEventListener('keydown', onKeyDown, true);
  insertButton.addEventListener('click', () => {
    if (!finalText || disposed) return;
    options.onInsert(finalText);
    close();
  });
  copyButton.addEventListener('click', () => {
    if (!finalText) return;
    void navigator.clipboard?.writeText(finalText);
  });

  return {
    open(sourceText, anchorRect) {
      if (disposed) return;
      finalText = '';
      source.textContent = sourceText;
      target.textContent = '';
      target.classList.add('streaming');
      insertButton.disabled = true;
      panel.hidden = false;
      // 贴着输入框：下方空间不足则翻到上方；水平夹取不出视口
      const below = window.innerHeight - anchorRect.bottom - VIEWPORT_MARGIN;
      const flip = below < 180 && anchorRect.top > 200;
      panel.style.top = flip
        ? `${Math.max(VIEWPORT_MARGIN, anchorRect.top - 320)}px`
        : `${anchorRect.bottom + 8}px`;
      const width = Math.min(PANEL_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
      panel.style.left = `${Math.max(VIEWPORT_MARGIN, Math.min(anchorRect.left, window.innerWidth - VIEWPORT_MARGIN - width))}px`;
    },
    appendDelta(text) {
      if (disposed || panel.hidden) return;
      target.textContent = stripParagraphTags(text);
    },
    finish(translation) {
      if (disposed || panel.hidden) return;
      finalText = stripParagraphTags(translation).trim();
      target.classList.remove('streaming');
      target.textContent = finalText;
      insertButton.disabled = finalText.length === 0;
    },
    showError(message) {
      if (disposed || panel.hidden) return;
      target.classList.remove('streaming');
      target.innerHTML = '';
      const line = document.createElement('div');
      line.className = 'status';
      line.textContent = message;
      target.append(line);
    },
    close,
    isOpen: () => !panel.hidden,
    destroy() {
      disposed = true;
      window.removeEventListener('keydown', onKeyDown, true);
      host.remove();
    },
  };
};

/** 触发点判定：可编辑元素（复用划词判定），且输入框须为有文本光标的类型——
 *  数字/勾选/日期类无选区语义，翻译回填会破坏控件行为，直接排除。 */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'password', 'tel', '']);

export const editableFromEvent = (target: EventTarget | null): HTMLElement | null => {
  const element = target instanceof HTMLElement ? target : null;
  if (!element || !isEditableTarget(element)) return null;
  if (element instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(element.type) ? element : null;
  return element;
};
