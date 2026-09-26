import { CONFIG_STORAGE_KEY, getConfig, type TranslatorConfig } from '../../utils/config';
import { describeKeyEvent } from '../../utils/shortcuts';
import { DEFAULT_MAX_BATCH_SIZE, flushPendingCacheWrites, restoreAllTranslations, stopTranslation, translatePage } from './trans';
import { APPLY_SITE_RULES_EVENT } from './siteRuleBridge';
import type { SiteRule } from '../../utils/siteRules';

/** 个人规则的同步快照：广播事件用 detail 携带（type-only 导入零体积），避免异步读存储与首翻竞态。 */
let cachedPersonalRules: SiteRule[] = [];
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
  cachedPersonalRules = config.siteRules;
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
        // 缺省批上限与 trans 的动态装箱合同一致（长文请求数 ÷16 的前提）
        const maxBatchSize = ((message as { maxBatchSize?: number })?.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE) as number;
        // 广播（同步派发）：插件独有入口在监听器里注入本会话规则集；油猴端无监听器 → 空规则
        window.dispatchEvent(new CustomEvent(APPLY_SITE_RULES_EVENT, { detail: { personalRules: cachedPersonalRules } }));
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

    // 页面卸载时断开观察，避免泄漏；并尽力刷写待写缓存——
    // 中途关标签/跳转不再丢弃已翻结果，回访可直接命中缓存（storage 写入尽力而为，不等待完成）。
    const dispose = (): void => {
      flushPendingCacheWrites();
      observer.disconnect();
      if (stateTimer) window.clearTimeout(stateTimer);
      unmountFloat();
      window.removeEventListener('keydown', handlePageShortcut, true);
    };
    window.addEventListener('pagehide', dispose, { once: true });
  },
});