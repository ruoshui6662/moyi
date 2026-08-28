import { defineConfig } from 'wxt';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 版本号单一来源：根 package.json 的 version 字段
const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'));
const version = pkg.version ?? '0.0.0';

export default defineConfig({
  srcDir: 'src',
  manifest: {
    version,
    name: '墨译 - AI 网页双语翻译',
    description: '基于大模型的沉浸式网页双语翻译：流式渲染、视口优先、上下文感知。支持 OpenAI 兼容服务商、DeepL、腾讯翻译、微软翻译、谷歌翻译。',
    permissions: ['storage', 'activeTab', 'scripting', 'contextMenus'],
    host_permissions: ['<all_urls>'],
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
    action: {
      default_title: '墨译',
      default_popup: 'popup.html',
      default_icon: {
        16: 'icon/16.png',
        32: 'icon/32.png',
        48: 'icon/48.png',
        128: 'icon/128.png',
      },
    },
    commands: {
      'translate-page': {
        suggested_key: { default: 'Alt+Shift+T' },
        description: '翻译当前页面',
      },
      'restore-page': {
        suggested_key: { default: 'Alt+Shift+R' },
        description: '恢复当前页面原文',
      },
    },
  },
});
