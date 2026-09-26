/**
 * 输入框翻译 content entrypoint（插件独有载体，红线 3：油猴 import 图不触及）。
 *
 * 触发：焦点在可编辑元素时按用户录制的应用内组合键（默认未设置=不触发）。
 * 防打扰三件套：
 *   - 仅信任键盘事件（isTrusted），拒绝页面伪造；
 *   - IME 组合期间（isComposing 或 compositionstart 标记）一律不响应；
 *   - 500ms 去抖 + 浮层已开时按新键重开。
 * 落笔只在用户点「替换」后发生；流式失败/取消保留原文照常。
 */

import { getConfig } from '../utils/config';
import { describeKeyEvent } from '../utils/shortcuts';
import { streamBatchTranslation } from '../utils/translateApi';
import {
  captureInputText,
  editableFromEvent,
  insertTranslation,
  mountInputTranslateOverlay,
} from './content/inputTranslate';

const TRIGGER_DEBOUNCE_MS = 500;
/** 输入框草稿上限：超长文本（如整封邮件）不按输入框翻译处理——那是文档翻译的事。 */
const DRAFT_MAX_CHARS = 2000;

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_idle',
  main() {
    let shortcut = '';
    let composing = false;
    let lastTriggerAt = 0;
    /** 本次浮层对应的编辑目标与插入位置（重开后随新目标覆盖）。 */
    let pendingTarget: { element: HTMLElement; start: number; end: number } | null = null;
    let activeStream: { abort: () => void } | null = null;

    void getConfig().then((config) => { shortcut = config.shortcuts.inputTranslate ?? ''; }).catch(() => undefined);
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes['personal-translator-config']) return;
      void getConfig().then((config) => { shortcut = config.shortcuts.inputTranslate ?? ''; }).catch(() => undefined);
    });

    document.addEventListener('compositionstart', () => { composing = true; }, true);
    document.addEventListener('compositionend', () => { composing = false; }, true);

    const overlay = mountInputTranslateOverlay({
      onInsert: (translation) => {
        const pending = pendingTarget;
        if (!pending) return;
        if (insertTranslation(pending.element, translation, pending.start, pending.end)) {
          pendingTarget = null;
        }
      },
    });

    const trigger = (element: HTMLElement): void => {
      if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
        const captured = captureInputText(element);
        if (!captured.text) return;
        if (captured.text.length > DRAFT_MAX_CHARS) return;
        const rect = element.getBoundingClientRect();
        pendingTarget = { element, start: captured.start, end: captured.end };
        openAndStream(captured.text, rect);
        return;
      }
      if (element.getAttribute('contenteditable') === 'true' || element.getAttribute('contenteditable') === '') {
        const selected = String(window.getSelection()?.toString() ?? '').trim();
        if (!selected || selected.length > DRAFT_MAX_CHARS) return;
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        pendingTarget = { element, start: 0, end: 0 };
        openAndStream(selected, rect);
      }
    };

    const openAndStream = (text: string, rect: DOMRect): void => {
      activeStream?.abort();
      overlay.open(text, { top: rect.top, bottom: rect.bottom, left: rect.left });
      const handle = streamBatchTranslation([text], {
        maxBatchSize: 1,
        onPartial: (_index, delta) => overlay.appendDelta(delta),
        onParagraph: (_index, translation) => overlay.finish(translation),
        onError: (error) => overlay.showError(error),
        onDone: () => undefined,
      });
      activeStream = handle;
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.isTrusted || !shortcut || composing || event.isComposing) return;
      if (describeKeyEvent(event) !== shortcut) return;
      const element = editableFromEvent(event.target);
      if (!element) return;
      const now = Date.now();
      if (now - lastTriggerAt < TRIGGER_DEBOUNCE_MS) return;
      lastTriggerAt = now;
      event.preventDefault();
      event.stopPropagation();
      trigger(element);
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pagehide', () => {
      activeStream?.abort();
      window.removeEventListener('keydown', onKeyDown, true);
      overlay.destroy();
    }, { once: true });
  },
});
