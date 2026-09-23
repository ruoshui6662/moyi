<div align="center">

# 墨译 · AI 网页双语翻译

**打开任意网页，一键中英对照阅读。**
原文在上、译文在下，逐段显示、随时还原。开源免费（GPL-3.0），
一个代码库两个版本：**Chrome 插件**（Manifest V3）与**油猴脚本**（Tampermonkey / Violentmonkey / Via）。

</div>

---

## 🙋 这是什么？

简单说：**你在网页上点一下，墨译就在每段原文下面垫上中文译文，让你对照着读。**

- **对照，而不是替换**：默认原文完整保留，译文加在下面，遇到看不懂的段落可以两句对照着理解；也支持"直接替换"模式，只显示译文。
- **网页本身零改动**：译文是浮在页面上的，随时一键还原，刷新页面也干干净净。
- **不用注册、不收集数据**：插件本身不上传任何东西；你填的 API Key 只存在自己浏览器本地。翻译时网页文字会发送到**你自己选择的**翻译服务（微软、DeepL、你自己的大模型接口……由你决定）。
- **快**：译文跟着模型输出一段段冒出来，不用盯着"加载中"转圈；打开过的文章第二次访问直接秒出（本地缓存 7 天）。

**第一次用怎么选？** 只想在电脑 Chrome 上用 → 装插件；手机浏览器或已装脚本管理器 → 装油猴脚本。两种装一个就行，功能基本一致，详见下面[怎么选](#-插件和油猴脚本怎么选)。

---

## ✨ 你能用它做什么

- **一键翻译整页**：点悬浮球、浏览器右键菜单、快捷键（`Alt+Shift+T`）、或工具栏弹窗按钮，四种方式任选；再按一次还原（`Alt+Shift+R`）。
- **边读边出**：译文随模型输出逐段出现，长文章也不用等整页翻完。
- **滚到哪翻到哪，还提前备好**：视口下方约两屏的内容会提前开始翻译，正常速度往下读基本不用等；超长文章滚动到底也能逐步翻完。
- **六种显示样式**：朱砂界线 / 黛青界线 / 竹青下划 / 月白高亮 / 无标记，以及隐藏原文的「直接替换」；深色底的网页会自动调亮译文颜色，保证看得清。
- **排版随你调**：译文相对原文的字号（80%–115%）、行距、字距、字体（跟随原文或指定系统字体）都能单独调，改完立即生效，不用刷新。
- **悬浮球**：可拖到页面任何位置，拖到边缘自动吸附成小胶囊，不挡阅读；大小（26–48px）和透明度可调。
- **视频双语字幕**（插件）：YouTube 和 X(Twitter) 视频里叠加双语字幕，支持规则断句与可选的 AI 断句，可在设置里开关。
- **上下文感知**：翻译时会把页面标题一并告诉模型，专有名词和术语前后更一致。
- **多服务商**：免密钥即用的微软/谷歌翻译、DeepL、腾讯翻译，OpenAI 兼容大模型（OpenAI / DeepSeek / Kimi / MiniMax / 智谱 + 自定义），以及本机 Ollama——见下方[配置说明](#-首次使用配置一个翻译服务)。
- **应用内快捷键**：页面里直接按组合键翻译/还原（可自定义录制），插件另保留浏览器级快捷键 `Alt+Shift+T / R`。

---

## 🔀 插件和油猴脚本怎么选

**只在电脑 Chrome/Edge 上用 → 装插件**（有工具栏弹窗、右键菜单、浏览器快捷键、视频字幕）。
**手机浏览器、或不想开开发者模式 → 装油猴脚本**（装在 Tampermonkey/Violentmonkey/Via 里，设置面板长按悬浮球打开）。

> 设计原则：**共享逻辑零复制**——改 bug 或加功能只改 `chrome-plugin/src`，油猴端重新构建即继承；只有「扩展能力替代品」（`userscript/src/compat`、`localBackground`、`settingsPanel`）是油猴专属代码。

```
                chrome-plugin/src （单一事实来源，约 1.5 万行）
                translation-core · service · utils · entrypoints/content
                   │ WXT 打包(MV3)            │ esbuild 打包(库方式 import)
                   ▼                          ▼
        Chrome 插件（Manifest V3）      油猴脚本（Tampermonkey/Violentmonkey/Via）
        background 代发网络请求          GM_xmlhttpRequest 替代网络
        chrome.storage 持久化            GM_* 存储 shim 替代持久化
        popup/options/右键菜单/系统快捷键   页内设置面板 + 菜单命令 + 长按手势
```

| 能力 | 插件 | 油猴脚本 |
|---|---|---|
| 触发入口 | 弹窗 / 右键菜单 / 系统快捷键 / 悬浮按钮 | 悬浮按钮点击、管理器菜单命令、应用内快捷键 |
| 设置界面 | options 独立页 | **长按悬浮按钮**打开页内面板（closed shadow DOM） |
| 跨域网络 | background service worker 代发 | `GM_xmlhttpRequest` 伪装成 fetch（流式不可用时同请求内自动降级整段解析） |
| 配置存储 | `chrome.storage.local` | `GM_getValue/set` shim（降级链：GM → localStorage → 内存） |
| 多标签热同步 | storage.onChanged | `GM_addValueChangeListener`（不可用时静默降级） |
| 视频字幕翻译 | YouTube + X/Twitter 双语字幕 | ➖（未移植） |

---

## 📦 安装

### Chrome 插件

```bash
npm install
npm run build          # 在 chrome-plugin/ 内执行 wxt build
cp -r chrome-plugin/.output/chrome-mv3 chrome-plugin/dist
```

1. 打开 `chrome://extensions`；
2. 打开右上角的 **开发者模式**；
3. 点 **加载已解压的扩展程序**，选择本仓库的 `chrome-plugin/dist` 文件夹；
4. 之后每次重新构建，回这个页面点卡片上的 **刷新按钮** 即可。

### 油猴脚本

**方式一（推荐）**：先在浏览器安装 Tampermonkey（手机 Via 浏览器内置脚本引擎），然后打开脚本页一键安装：

[墨译-油猴（Greasy Fork）](https://greasyfork.org/zh-CN/scripts/592835-%E5%A2%A8%E8%AF%91-ai-%E7%BD%91%E9%A1%B5%E5%8F%8C%E8%AF%AD%E7%BF%BB%E8%AF%91-%E6%B2%B9%E7%8C%B4%E7%89%88)

**方式二（本地构建）**：

```bash
npm run build:userscript   # 产物：userscript/dist/moyi.user.js（未压缩，符合 Greasy Fork 可读性要求）
```

在 Tampermonkey 里「添加新脚本」粘贴全文保存；Via 浏览器：脚本 → 新建 → 粘贴启用。

---

## ⚙️ 首次使用：配置一个翻译服务

墨译本身**不自带翻译服务**，第一次用需要在设置里选一个：

- **想开箱即用**：选「**微软翻译**」——不用注册、不用密钥，选中后直接点「测试连接」就能用（走 Edge 内置网页翻译端点，文本发送至微软服务器，非 Microsoft 商业 SLA）；「谷歌翻译」同理免密钥，但 **Google 服务在国内通常无法直连**，测试失败多半是网络问题；
- **想用大模型翻译质量**：填任意 OpenAI 兼容接口（OpenAI / DeepSeek / Kimi / MiniMax / 智谱 / 中转站），或本机 **Ollama**（免密钥，先 `ollama pull 模型名`）；
- **按字符计费的翻译 API**：DeepL（免费/专业套餐）、腾讯翻译（SecretId + SecretKey，基础翻译每月有免费额度）。

| 类型 | 说明 |
|---|---|
| OpenAI 兼容（内置 5 家 + 自定义） | 填写接口地址、API Key、模型名；可「获取模型」「测试连接」；建议开启「关闭推理模式」以省 token |
| DeepL | 选择**免费版（api-free）或专业版（api.deepl）**接口套餐，填写 API Key；无需模型、无需提示词 |
| 腾讯翻译 | 填写接口地址、**SecretId（「API Key」字段）+ SecretKey** 与地域（默认 ap-guangzhou）；密钥在腾讯云控制台「API 密钥管理」申请，需在机器翻译控制台开通；无需模型、无需提示词 |
| 微软翻译 | **无需密钥与接口地址**，选中后直接「测试连接」即可用 |
| 谷歌翻译 | **无需密钥与接口地址**，选中后直接「测试连接」即可用；**国内通常无法直连** |
| Ollama（仅 Chrome 插件） | 本机 `http://localhost:11434/v1`，填写模型即可（例如 `qwen3:8b`）。若连接返回 403，需设置 `OLLAMA_ORIGINS` 放行扩展来源（详见设置页内提示） |

**接口地址安全规则**：公网必须 `https://`；本机/内网（localhost、127.x、10.x、172.16–31.x、192.168.x、*.local）允许 `http://`——你的 Key 只会在你信任的网络里传输。

**配置入口**：插件 → 工具栏弹窗 → 「设置」；油猴 → **长按悬浮球**或菜单命令「墨译 · 设置」。填完点「**测试连接**」看到「连接成功」，再回到网页点悬浮球即可。

---

## 📖 使用说明

- **翻译页面**：插件——悬浮球 / 弹窗按钮 / 右键「墨译 · 翻译当前页」/ 快捷键；油猴——点悬浮球或管理器菜单命令。
- **移除译文**：再点一次悬浮球、或快捷键 `Alt+Shift+R`。
- **打开设置**：插件——工具栏弹窗 → 「设置」；油猴——**长按悬浮球**，或控制台执行 `__MOYI__.openPanel()`。
- **悬浮球**：可拖拽；拖到左右边缘会吸附成胶囊，悬停展开；大小与透明度在设置 → 样式里调。
- **样式与排版**：设置 → 样式，改动自动保存并即时生效于已翻译页面，无需刷新。
- **视频字幕**（插件）：设置 → 字幕翻译里开启，之后打开 YouTube/X 视频自动加载并翻译字幕。

---

## 🛠 技术路线（简单介绍）

**一套核心，两个发行版**：翻译管线（找段落 → 分批调用后端 → 双语回填 DOM）、服务商接入、配置与缓存全部住在 `chrome-plugin/src`，作为单一事实来源；油猴脚本把它当库复用，只实现一层「浏览器扩展能力」的替代品。

```
触发（按钮/菜单/快捷键）
  → 采集候选段落（硬剪枝：代码/URL/公式/自产节点一概跳过）
  → 视口内立即入队，视口下方 1400px 提前预取；批 8 并发 3，单批 6000 字符预算
  → [插件] background 代发请求   [油猴] GM_xmlhttpRequest 伪装 fetch
  → SSE 流式增量，按 <paragraph_N> 标签逐段回填 DOM（增量只写文字，不重建样式）
  → 段落级缓存写入（7 天 / 5000 条 LRU），关页前尽力刷写
```

- **无框架**：原生 TypeScript（strict）+ 原生 DOM，UI 隔离在 closed Shadow DOM，不引 UI 库、不引 AI SDK（手写 fetch，自托管友好）；
- **服务商抽象**：后端只分两类——`openai`（兼容协议，可流式、有提示词）与 `mt`（DeepL/腾讯/微软/谷歌的适配器家族，按字符计费、整批直译）；
- **稳定性机制**：流式 30 秒空闲超时 + 5 分钟硬上限、`finish_reason=length` 截断检测、网络错误与 408/502/503/504 退避重试、长文滚动节流补扫；
- **设计**：统一 Apple Human Interface Guidelines 设计 token（系统蓝强调色、明暗双套、4px 间距网格），双端一致；
- **质量**：TypeScript strict 全量类型检查通过；**401 项 Vitest 单测（37 个文件）全部通过**；设计 token 有防漂移测试守护。

更深的设计推导见下方[文档索引](#-文档索引)。

---

## 🧑‍💻 开发者

### 开发与验证

```bash
npm install                 # 安装依赖
npm run dev                 # 插件开发模式（WXT，运行于 chrome-plugin/）
npm run compile             # TypeScript 类型检查
npm test                    # 单元测试（Vitest + jsdom）
npm run build               # 插件生产构建 → chrome-plugin/.output/chrome-mv3
npm run build:userscript    # 油猴构建 → userscript/dist/moyi.user.js
```

端到端冒烟（手动）：`npx http-server . -p 8123` 后访问
`http://localhost:8123/userscript/fixtures/userscript-smoke.html#smoke-full`，
页面标题会在数秒后变为 `SMOKE-FULL:T0-O:0`（翻译→渲染→还原全链路断言）；`#smoke-translate`、`#smoke-panel` 分别单独验证翻译与设置面板。夹具内含 GM API 模拟，无需真实 Key。

### 从源码发布

- 油猴：直接上传 `userscript/dist/moyi.user.js` 到 Greasy Fork 等站点；**每次更新记得递增根 `package.json` 的 `version`**（会写入 `@version` 头）。
- CRX 打包：`chrome-plugin/scripts/gen-crx-key.mjs`。

### ⚠️ 已知限制与待办（接手优先看，2026-09-22 逐条核对）

1. `chrome-plugin/github-upload/` 是**旧结构的发布快照**（v0.1.0，仅含 OpenAI 兼容 + DeepL），重新对外发布前需从 `chrome-plugin/src` 重新同步，勿直接编辑；
2. 扩展 options 页尚未暴露悬浮按钮大小/透明度滑杆（配置字段与渲染已就绪，油猴面板已可调，补两个控件即可）;
3. 油猴面板的「获取模型」用 `prompt()` 弹窗选择模型，是移动端可用性折衷，可升级为下拉；
4. Via 真机只做了能力探测与降级设计，未做大规模机型实测；欢迎反馈具体页面；
5. 尚无 CI，测试需本地 `npm test`；
6. 扩展 options 页字幕分区仅有 YouTube 开关，**X 站字幕开关（`xEnabled`）与 AI 断句开关（`aiSegmentation`）无设置控件**（配置字段已生效、默认开启，读取时记忆保存时原样回写）；设置页文案也只提 YouTube；
7. X/Twitter 加密 HLS 字幕分段暂不支持解密，命中时提示「字幕分声明了加密，暂不支持」；
8. 字幕「同语言跳过」判定仅对中文系目标语言可靠，非中文目标语言退化为严格语言码匹配；
9. 429 与超时仍不自动重试（OpenAI 兼容族已对网络错误与 408/502/503/504 做 2 次退避重试，腾讯另有 429 限流退避）；
10. 测试盲区：`background.ts` 消息路由、`trans.ts` 编排主流程、options/popup UI、YouTube/X content script 壳、油猴 `fetchShim/localBackground/settingsPanel` 均无单测（纯函数层覆盖良好）；无 e2e。

### ⚠️ 踩坑记录（改动前必读）

1. **行高必须是倍率不能是 px**：Android WebView 的 font boosting 会膨胀字号，px 行高会导致行重叠；见 `translationRenderer.ts` 内注释。
2. **行距下限 1.0**：`(0,1.0)` 对 CJK 是物理非法区（必然乱码），清洗层与两端滑杆磁性吸附都已封死，不要放开。
3. **油猴产物禁止压缩**：Greasy Fork 拒绝 minified 自有代码，`build.mjs` 保持 `minify: false`。
4. **一切 GM 能力先探测再使用**：Via 与桌面管理器能力面参差，缺失即静默降级，不硬崩。
5. **共享核心改动跑全量测试**：`npm run compile && npm test`；油猴端行为由同一批测试间接守护。
6. **端点校验：公网强制 https、内网放行 http**——Key 只在用户信任边界内明文传输。
7. **测试连接只用表单值、不回退存量 Key**——杜绝任意上下文把真实 Key 发往自填 endpoint。

### 📚 文档索引

- `规划/浏览器翻译插件-第一性原理与自研路线.md` —— 插件最初的整体设计与路线（P0–P3 清单已回填实际进度）
- `规划/油猴脚本-第一性原理迁移规划.md` —— 双发行版架构与迁移决策（已全部落地）
- `规划/腾讯翻译接入-第一性原理设计.md` —— 传统 MT 适配器家族抽象 + 腾讯/微软/谷歌接入（P0 已完成）
- `规划/UI重构-Apple设计规范对照设计规划.md` —— 双端设计系统重构的设计推导与 token 规格
- `规划/进度归档/` —— 历次会话实施计划归档（UI 重构 / DeepL / Logo / YouTube 控件 / AI 断句），含索引 README
- 各模块头注释记录了对应的设计约束与防御原因，改动前建议先读所在文件头部

---

## 📄 许可证

[GPL-3.0](LICENSE)

## 📚 项目参考

本项目的设计与实现借鉴了以下开源项目，特此致谢：

- **[FluentRead](https://github.com/Bistutu/FluentRead)**（GPL-3.0）—— 页面文本剪枝/切段规则、翻译状态机（WeakMap + generation）、视口懒翻译等核心思路；
- **[陪读蛙 Read Frog](https://github.com/mengxi-ream/read-frog)**（GPLv3）—— 字幕 AI 断句的方法与提示词结构（实现见 `chrome-plugin/src/utils/subtitles/ai-segmenter.ts` 头部注释，提示词为独立重写）；
- **[沉浸式翻译](https://github.com/immersive-translate/immersive-translate)** —— 悬浮球设计模式（实现见 `chrome-plugin/src/entrypoints/content/floatingButton.ts` 头部注释）。

以上借鉴均限于思路与规则层面的学习，代码为独立重写，未复制其源代码；本仓库以 GPL-3.0 发布，与参考项目许可一致。
