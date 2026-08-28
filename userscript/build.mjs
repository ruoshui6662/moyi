/**
 * 油猴脚本构建：esbuild 打包为单文件 IIFE，头部拼接 UserScript 元数据。
 *
 * 产物：userscript/dist/moyi.user.js
 * 版本号单一来源：根 package.json 的 version。
 *
 * 元数据要点：
 *   - @match http/https —— 与扩展注入范围一致（内部页面不注入）；
 *   - @noframes —— 对齐扩展默认仅顶层帧注入的行为；
 *   - @connect * —— 自定义服务商可指向任意域名；跨域豁免由管理器按此白名单授予；
 *   - @grant 列表即能力面声明：存储、值变更监听、网络、菜单。
 */

import { build } from 'esbuild';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const version = pkg.version ?? '0.0.0';

const header = `// ==UserScript==
// @name         墨译 - AI 网页双语翻译 (油猴版)
// @name:en      MoYi - AI Bilingual Web Translator (Userscript)
// @namespace    moyi-userscript
// @version      ${version}
// @description  基于大模型的沉浸式网页双语翻译：流式渲染、视口优先、上下文感知；支持 OpenAI 兼容服务商、DeepL、腾讯翻译与微软翻译。适用于 Tampermonkey/Violentmonkey 与 Via 浏览器。
// @description:en  Immersive bilingual web translation powered by LLMs: streamed rendering, viewport-first batching, page-context awareness. Works with OpenAI-compatible providers, DeepL, Tencent TMT and Microsoft Translator.
// @author       墨译
// @license      GPL-3.0
// @match        http://*/*
// @match        https://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-end
// @noframes
// ==/UserScript==
`;

mkdirSync(resolve(root, 'userscript', 'dist'), { recursive: true });

await build({
  entryPoints: [resolve(here, 'src', 'entry.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  outfile: resolve(root, 'userscript', 'dist', 'moyi.user.js'),
  banner: { js: header },
  // Greasy Fork 等脚本站禁止压缩/混淆的自有代码：发布构建必须保持可读（minify: false）
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
});
