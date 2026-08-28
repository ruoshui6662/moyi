import { CONFIG_STORAGE_KEY, getConfig, type TranslatorConfig } from '../../utils/config';
import { describeKeyEvent } from '../../utils/shortcuts';
import { restoreAllTranslations, stopTranslation, translatePage } from './trans';
import { applyTranslationStyles, toTranslationTheme } from './translationRenderer';
import { applyFloatAppearance, mountFloatingButton, syncFloatingButtonState, type FloatingButtonOptions } from './floatingButton';

/** 同一组合键的最短触发间隔，避免长按/重复键连续触发。 */
const SHORTCUT_DEBOUNCE_MS = 500;

let shortcutTranslate = '';
let shortcutRestore = '';
let lastShortcutTriggerAt = 0;

const applyShortcuts = (config: TranslatorConfig): void => {
  shortcutTranslate = config.shortcuts.translate;
  shortcutRestore = config.shortcuts.restore;
};

const refreshConfig = async (): Promise<void> => {
  const config = await getConfig();
  applyTranslationStyles(toTranslationTheme(config));
  applyShortcuts(config);
  // 悬浮按钮外观随配置热更新；按钮未挂载时内部静默跳过
  applyFloatAppearance({ size: config.floatSize, opacity: config.floatOpacity });
};

const handlePageShortcut = (event: KeyboardEvent): void => {
  // 拒绝页面合成的键盘事件：否则恶意网页可伪造组合键驱动扩展发起整页翻译
  if (!event.isTrusted) return;
  const combo = describeKeyEvent(event);
  if (!combo) return;
  const target: 'translate' | 'restore' | null =
    combo === shortcutTranslate ? 'translate' : combo === shortcutRestore ? 'restore' : null;
  if (!target) return;

  const now = Date.now();
  if (now - lastShortcutTriggerAt < SHORTCUT_DEBOUNCE_MS) return;
  lastShortcutTriggerAt = now;

  event.preventDefault();
  event.stopPropagation();
  if (target === 'translate') {
    void translatePage().catch((error) => {
      console.error('[墨译] 快捷键翻译失败', error);
    });
  } else {
    restoreAllTranslations();
  }
};

/** 页面是否已渲染译文（悬浮按钮状态依据）。 */
const hasAnyTranslation = (): boolean =>
  document.querySelectorAll('[data-personal-translator-owned]').length > 0;

export default defineContentScript({
  // 收敛注入范围：仅在 http/https 网页注入；file/内部页面不留悬浮按钮与页面级监听
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_idle',
  main() {
    chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
      const type = (message as { type?: string } | null)?.type;
      if (type === 'translate-page') {
        const maxBatchSize = ((message as { maxBatchSize?: number })?.maxBatchSize ?? 5) as number;
        void translatePage(maxBatchSize).then((result) => sendResponse({ ok: true, ...result })).catch((error) => {
          sendResponse({ ok: false, error: error instanceof Error ? error.message : '翻译失败。' });
        });
        return true;
      }
      if (type === 'restore-page') {
        restoreAllTranslations();
        sendResponse({ ok: true });
        return false;
      }
      if (type === 'stop-translation') {
        stopTranslation();
        sendResponse({ ok: true });
        return false;
      }
      return false;
    });

    void refreshConfig();

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes[CONFIG_STORAGE_KEY]) return;
      void refreshConfig();
    });

    window.addEventListener('keydown', handlePageShortcut, true);

    // 悬浮按钮：点击翻译/还原，译文出现后按钮切换「还原」状态。
    // __moyiOnFloatLongPress 为油猴脚本注入的长按钩子（打开设置面板）；扩展环境不存在，行为不变。
    const longPressHook = (globalThis as { __moyiOnFloatLongPress?: () => void }).__moyiOnFloatLongPress;
    const floatOptions: FloatingButtonOptions = {
      isTranslated: hasAnyTranslation,
      onToggle: () => {
        if (hasAnyTranslation()) {
          restoreAllTranslations();
        } else {
          void translatePage().catch((error) => {
            console.error('[墨译] 悬浮按钮翻译失败', error);
          });
        }
      },
      ...(longPressHook ? { onLongPress: longPressHook } : {}),
    };
    const unmountFloat = mountFloatingButton(floatOptions);

    let stateTimer: number | undefined;
    const observer = new MutationObserver(() => {
      window.clearTimeout(stateTimer);
      stateTimer = window.setTimeout(() => syncFloatingButtonState(floatOptions), 120);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // 页面卸载时断开观察，避免泄漏
    const dispose = (): void => {
      observer.disconnect();
      if (stateTimer) window.clearTimeout(stateTimer);
      unmountFloat();
      window.removeEventListener('keydown', handlePageShortcut, true);
    };
    window.addEventListener('pagehide', dispose, { once: true });
  },
});