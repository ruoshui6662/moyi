<div align="center">

# 墨译 · AI 网页双语翻译

基于大模型的沉浸式网页双语翻译 —— **流式渲染、视口优先、上下文感知**。
一个代码库，两个发行版：**Chrome 插件**（Manifest V3）与**油猴脚本**（Tampermonkey / Violentmonkey / Via）。

</div>

---

## 🔍 三十秒看懂：两个发行版的关系

**一套核心，两个壳。** 翻译管线（文本采集 → 批量/流式调用后端 → 双语回填 DOM）、服务商接入、配置与缓存全部住在 `chrome-plugin/src` 里，作为**单一事实来源**；油猴脚本把它当库复用，只额外实现一层「浏览器扩展能力」的替代品。

```
                    ┌────────────────────────────────────┐
                    │   chrome-plugin/src （共享核心）      │
                    │   translation-core · service        │
                    │   utils(config/providers/…)         │
                    │   entrypoints/content （页面管线）    │
                    └──────────────┬─────────────────────┘
                WXT 打包 ↓                        ↑ esbuild 打包（作为库 import）
   ┌──────────────────────────┐        ┌──────────────────────────────┐
   │ Chrome 插件 (MV3)         │        │ 油猴脚本 (userscript/)        │
   │ background 代发网络请求     │        │ GM_xmlhttpRequest 替代网络     │
   │ chrome.storage 持久化      │        │ GM_* 存储 shim 替代持久化       │
   │ popup/options/contextMenu │        │ 页内设置面板 + 菜单命令 + 长按   │
   └──────────────────────────┘        └──────────────────────────────┘
```

| 能力 | 插件 | 油猴脚本 |
|---|---|---|
| 触发入口 | 弹窗 / 右键菜单 / 系统快捷键 / 悬浮按钮 | 悬浮按钮点击、管理器菜单命令、应用内快捷键 |
| 设置界面 | options 独立页 | **长按悬浮按钮**打开页内面板（closed shadow DOM） |
| 跨域网络 | background service worker 代发 | `GM_xmlhttpRequest` 伪装成 fetch（流式不可用时同请求内自动降级整段解析） |
| 配置存储 | `chrome.storage.local` | `GM_getValue/set` shim（降级链：GM → localStorage → 内存） |
| 多标签热同步 | storage.onChanged | `GM_addValueChangeListener`（不可用时静默降级） |

> 设计原则：**共享逻辑零复制**。改 bug 或加功能只改 `chrome-plugin/src`，油猴端重新构建即继承；
> 只有「扩展能力替代品」（`userscript/src/compat`、`localBackground`、`settingsPanel`）是油猴专属代码。
> 详细推导见 `规划/油猴脚本-第一性原理迁移规划.md`。

## 📈 开发进度（2026-08）

### ✅ 已完成

**Chrome 插件**
- 核心管线：段落候选发现、视口优先分批（批 5 并发 3）、流式逐段渲染、滚动按需续译
- 服务商：OpenAI 兼容 ×5（OpenAI / DeepSeek / Kimi / MiniMax / 智谱 GLM）+ 自定义服务商增删 + DeepL 官方 API（免费/专业套餐）+ 腾讯翻译（TMT，SecretId/SecretKey）+ 微软翻译（Edge 免密钥端点）+ 谷歌翻译（translate-pa 免密钥端点）
- 设置页：凭据管理与校验、获取模型列表、测试连接、关闭推理模式、提示词风格/自定义提示词、译文样式六件套、快捷键录制、恢复出厂
- 渲染：六种双语样式、字号/行距/字距/字体独立调节、暗色背景自适应提亮、替换模式（隐藏原文）
- 段落级译文缓存（7 天 TTL / 5000 条 LRU）
- 悬浮按钮：拖拽、边缘吸附胶囊、悬停展开、长按手势钩子、大小（26–48px）与透明度可调

**油猴脚本**（与插件功能对齐，差异见上表）
- GM 适配层四件套：存储 shim、消息总线 shim（sendMessage/connect Port 本地化）、fetch shim、能力探测
- 本地 background：完整复刻消息处理角色；GM 流式传输 + 请求内自动降级
- 页内设置面板：服务商/翻译偏好/样式/快捷键/数据管理全功能
- 控制台自动化接口：`__MOYI__.translateNow() / restoreNow() / openPanel()`
- 已通过带 GM 模拟夹具的端到端冒烟（翻译/还原/面板全链路）

### 🧪 质量状态

- TypeScript strict 全量类型检查通过；**198 项 Vitest 单测全部通过**（覆盖共享核心、双端适配层、边界清洗）
- 双发行版均可一键构建；产物已实测加载

### ⚠️ 已知限制与待办（接手优先看）

1. `chrome-plugin/github-upload/` 是**旧结构的发布快照**，重新对外发布前需从 `chrome-plugin/src` 重新同步，勿直接编辑；
2. 扩展 options 页尚未暴露悬浮按钮大小/透明度滑杆（配置字段与渲染已就绪，油猴面板已可调，补两个控件即可）;
3. 油猴面板的「获取模型」用 `prompt()` 弹窗选择模型，是移动端可用性折衷，可升级为下拉；
4. Via 真机只做了能力探测与降级设计，未做大规模机型实测；欢迎反馈具体页面；
5. 尚无 CI，测试需本地 `npm test`。

## ✨ 功能总览

- **流式渲染**：译文随模型输出逐段渐进显示，长页面无需等待完整结果。
- **视口优先**：只翻译视口内的内容，滚动时按需继续，首屏响应快。
- **上下文感知**：携带页面标题与描述作为上下文，译文术语一致性更好。
- **段落级译文缓存**：同一文本再次翻译直接命中缓存，零请求、即时显示（7 天过期、自动淘汰）。
- **多种服务商**：
  - OpenAI 兼容大模型服务商：OpenAI、DeepSeek、Kimi、MiniMax、智谱 GLM，以及自定义服务商；
  - DeepL 官方翻译 API（免费版 / 专业版可选，无需提示词、按字符计费）；
  - 腾讯翻译 TMT（官方云 API，SecretId + SecretKey 双密钥，无需提示词、按字符计费，基础翻译有免费额度）；
  - 微软翻译（Edge 内置网页翻译端点，**免密钥**、无模型字段，文本发送至微软服务器；该端点为未公开在线服务，非 Microsoft 商业 SLA）；
  - 谷歌翻译（Google 翻译服务端点，**免密钥**、无模型字段，文本发送至 Google 服务器；该端点为未公开在线服务，非 Google 商业 SLA；**Google 服务在国内通常无法直连**）。
- **五种双语样式 + 直接替换**：朱砂界线 / 黛青界线 / 竹青下划 / 月白高亮 / 无标记，以及隐藏原文的「直接替换」模式。
- **细致的排版控制**：字号（相对原文）、行距、字距、字体（跟随原文或指定系统字体）均可调，改动自动保存并即时生效。
- **暗色网页自适应**：深色背景下译文颜色自动提亮，保证可读。
- **可移动悬浮按钮**：拖到页面边缘自动吸附为贴边胶囊，悬停展开、点击翻译 / 还原；大小（26–48px）与透明度可调——默认 32px、90% 不透明度，闲置半透明、悬停/按下时自动全显。
- **快捷键**：支持在设置内录制应用内快捷键（页面内触发），插件另保留 Chrome 系统级快捷键。
- **右键一键翻译**（仅插件）：浏览器右键直接出现「墨译 · 翻译当前页」。

## 🏗 架构：一次翻译的完整链路

```
触发（按钮/菜单/快捷键）
  → trans.ts: 采集候选（engine/dom/layout/text）→ 视口内外分流
  → BatchingScheduler 分批并发
  → [插件] runtime 消息 → background.ts → service/common·deepl → fetch
  → [油猴] runtime 总线 shim → localBackground → 同一套 service 层 → fetch shim(GM_xhr)
  → SSE 增量 → createTagStreamParser 解析 <paragraph_N> 标签（或整体解析自动降级）
  → renderer 按 typography 快照派生内联样式 → 双语节点挂载
  → 缓存写入（translationCache）/ 悬浮按钮状态同步
```

关键设计决策（均有文档推导，见 `规划/`）：

| 决策 | 一句话理由 |
|---|---|
| 油猴 = content+background 合体，消息总线本地化 | 不重写管线，扩展语义原样保留 |
| 行高输出单位无关倍率而非 px | 移动端 WebView 字体自动放大（font boosting）下保持几何一致 |
| 行距合法域 `{0} ∪ [1.0, 2.5]` | CJK 字形占满 em 方块，倍率 <1.0 行盒必然矮于字形 → 必然重叠 |
| 端点校验：公网强制 https、内网放行 http | Key 只在用户信任边界内明文传输 |
| 测试连接只用表单值、不回退存量 Key | 杜绝任意上下文把真实 Key 发往自填 endpoint |

## 🚀 安装与发布

### Chrome 插件

```bash
npm install
npm run build          # 在 chrome-plugin/ 内执行 wxt build
cp -r chrome-plugin/.output/chrome-mv3 chrome-plugin/dist
```

`chrome://extensions` 开启开发者模式 → 加载已解压的扩展程序 → 选 `chrome-plugin/dist`。之后每次构建后在扩展页点刷新。

### 油猴脚本

```bash
npm run build:userscript   # 产物：userscript/dist/moyi.user.js（未压缩，符合 Greasy Fork 可读性要求）
```

[墨译-油猴](https://greasyfork.org/zh-CN/scripts/592835-%E5%A2%A8%E8%AF%91-ai-%E7%BD%91%E9%A1%B5%E5%8F%8C%E8%AF%AD%E7%BF%BB%E8%AF%91-%E6%B2%B9%E7%8C%B4%E7%89%88)


## 📖 使用

- **翻译页面**：插件——弹窗/右键/快捷键/悬浮按钮；油猴——悬浮按钮点击或管理器菜单命令。
- **移除译文**：悬浮按钮点击（已翻译态）、还原入口或快捷键。
- **打开设置**：插件——工具栏弹窗 → 设置；油猴——**长按悬浮按钮**、菜单命令「墨译 · 设置」，或控制台 `__MOYI__.openPanel()`。
- **悬浮按钮**：可拖拽；贴边吸附为胶囊，悬停展开；大小与透明度在设置的「样式」页调节。
- **样式与排版**：设置 → 样式，改动自动保存并对已渲染译文即时生效。

## ⚙️ 配置服务商

| 类型 | 说明 |
|---|---|
| OpenAI 兼容（内置 5 家 + 自定义） | 填写接口地址、API Key、模型名；可「获取模型」「测试连接」；建议开启「关闭推理模式」以省 token |
| DeepL | 选择**免费版（api-free）或专业版（api.deepl）**接口套餐，填写 API Key；无需模型、无提示词 |
| 腾讯翻译 | 填写接口地址、**SecretId（「API Key」字段）+ SecretKey** 与地域（默认 ap-guangzhou）；密钥在腾讯云控制台「API 密钥管理」申请，需在机器翻译控制台开通；无需模型、无提示词 |
| 微软翻译 | **无需密钥与接口地址**，选中后直接「测试连接」即可用；走 Edge 内置网页翻译端点，文本发送至微软服务器，非 Microsoft 商业 SLA |
| 谷歌翻译 | **无需密钥与接口地址**，选中后直接「测试连接」即可用；走 Google 翻译服务端点，文本发送至 Google 服务器；**国内通常无法直连**，测试失败多为网络不可达 |

> 提示：模型聚合 / 轮换若包含推理模型，可能因思维链占满输出导致正文为空；建议聚合只使用普通模型，或开启「关闭推理」。
> 接口地址安全规则：公网必须 `https://`；本机/内网（localhost、127.x、10.x、172.16–31.x、192.168.x、*.local）允许 `http://`。

## 🧪 开发与验证

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

## ⚠️ 踩坑记录（改动前必读）

1. **行高必须是倍率不能是 px**：Android WebView 的 font boosting 会膨胀字号，px 行高会导致行重叠；见 `translationRenderer.ts` 内注释。
2. **行距下限 1.0**：`(0,1.0)` 对 CJK 是物理非法区（必然乱码），清洗层与两端滑杆磁性吸附都已封死，不要放开。
3. **油猴产物禁止压缩**：Greasy Fork 拒绝 minified 自有代码，`build.mjs` 保持 `minify: false`。
4. **一切 GM 能力先探测再使用**：Via 与桌面管理器能力面参差，缺失即静默降级，不硬崩。
5. **共享核心改动跑全量测试**：`npm run compile && npm test`；油猴端行为由同一批测试间接守护。

## 🛠 技术栈

- **WXT 0.20** + **Chrome Manifest V3** + **TypeScript**（strict）
- 原生 DOM + 内联 CSS（closed Shadow DOM 隔离 UI），无前端框架
- esbuild（油猴单文件打包）；**Vitest**（jsdom）单元测试

## 📚 文档索引

- `规划/浏览器翻译插件-第一性原理与自研路线.md` —— 插件最初的整体设计与路线
- `规划/油猴脚本-第一性原理迁移规划.md` —— 双发行版架构与迁移决策
- 各模块头注释记录了对应的设计约束与防御原因，改动前建议先读所在文件头部

## 🙏 致谢

本项目的设计与实现借鉴了以下开源项目，特此致谢：

- **[FluentRead](https://github.com/Bistutu/FluentRead)**（GPL-3.0）—— 页面文本剪枝/切段规则、翻译状态机（WeakMap + generation）、视口懒翻译等核心思路；
- **[陪读蛙 Read Frog](https://github.com/mengxi-ream/read-frog)**（GPLv3）—— 字幕 AI 断句的方法与提示词结构（实现见 `chrome-plugin/src/utils/subtitles/ai-segmenter.ts` 头部注释，提示词为独立重写）；
- **[沉浸式翻译](https://github.com/immersive-translate/immersive-translate)** —— 悬浮球设计模式（实现见 `chrome-plugin/src/entrypoints/content/floatingButton.ts` 头部注释）。

以上借鉴均限于思路与规则层面的学习，代码为独立重写，未复制其源代码；本仓库以 GPL-3.0 发布，与参考项目许可一致。

## 📄 许可证

[GPL-3.0](LICENSE)
