/**
 * 墨译油猴脚本入口。
 *
 * 启动顺序（顺序即正确性）：
 *   1. 安装 chrome.storage.local / chrome.runtime 消息总线 shim —— 共享模块对扩展 API 的
 *      全部依赖在此落地；
 *   2. 安装 fetch shim —— service 层的网络调用改走 GM_xmlhttpRequest（跨域豁免），
 *      必须在注册本地 background 与启动 content 管线之前完成；
 *   3. 注册「本地 background」消息/端口处理器 —— 复刻 background.ts 角色；
 *   4. 注入悬浮按钮长按钩子，提供 defineContentScript 全局并动态加载 content main ——
 *      WXT 的内容脚本包装在打包环境由本 shim 替代，main() 立即执行
 *      （@run-at document-end ≈ document_idle）；
 *   5. 注册管理器菜单命令（翻译 / 还原 / 设置）。
 *
 * 页面上下文不受影响：所有 shim 都落在脚本沙箱作用域，closed shadow DOM 隔离 UI。
 */

import { installStorageShim, watchKeyForRemoteChanges } from './compat/storageShim';
import { installBusShim } from './compat/busShim';
import { installFetchShim } from './compat/fetchShim';
import { registerLocalBackground } from './localBackground';
import { getGm, getRegisterMenuCommand } from './compat/gm';
import { CONFIG_STORAGE_KEY } from '../../chrome-plugin/src/utils/config';
import { TRANSLATION_CACHE_KEY } from '../../chrome-plugin/src/entrypoints/content/translationCache';

const openPanel = (): void => {
  void import('./settingsPanel').then(({ openSettingsPanel }) => openSettingsPanel());
};

const boot = async (): Promise<void> => {
  installStorageShim();
  installBusShim();
  installFetchShim();

  // 跨标签页热同步：配置变更驱动已打开页面的样式刷新（content main 监听 storage.onChanged）
  watchKeyForRemoteChanges([CONFIG_STORAGE_KEY, TRANSLATION_CACHE_KEY, 'moyi-float-position']);

  registerLocalBackground();

  if (!getGm()) {
    console.warn(
      '[PersonalTranslator] 未检测到 GM 存储 API：配置将退化为站点级 localStorage，建议使用 Tampermonkey / Violentmonkey 或 Via 安装本脚本。',
    );
  }

  // 悬浮按钮长按 → 打开设置（content main 在装配悬浮按钮时读取该钩子）
  (globalThis as unknown as Record<string, unknown>).__moyiOnFloatLongPress = openPanel;

  // WXT 内容脚本包装的打包环境替代：定义即执行 main()
  (globalThis as unknown as Record<string, unknown>).defineContentScript = (
    definition: { main?: () => void },
  ): void => {
    definition.main?.();
  };

  // content main：注入样式、快捷键、悬浮按钮、storage 监听
  await import('../../chrome-plugin/src/entrypoints/content/main');

  // 管理器菜单命令（桌面 Tampermonkey/Violentmonkey 支持；Via 视版本支持）
  const registerMenuCommand = getRegisterMenuCommand();
  const translateNow = (): void => {
    void import('../../chrome-plugin/src/entrypoints/content/trans').then(({ translatePage }) => {
      translatePage().catch((error: unknown) => {
        console.error('[墨译] 翻译失败', error);
      });
    });
  };
  const restoreNow = (): void => {
    void import('../../chrome-plugin/src/entrypoints/content/trans').then(({ restoreAllTranslations }) => restoreAllTranslations());
  };

  // 极简自动化面：供脚本管理器菜单、冒烟测试与高级用户在控制台触发
  (globalThis as unknown as Record<string, unknown>).__MOYI__ = { openPanel, translateNow, restoreNow };

  if (registerMenuCommand) {
    registerMenuCommand('墨译 · 翻译当前页', translateNow);
    registerMenuCommand('墨译 · 移除译文', restoreNow);
    registerMenuCommand('墨译 · 设置', openPanel);
  }
};

void boot();
