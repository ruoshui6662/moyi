# 墨译 UI 重构 — Apple HIG 对照设计规划

> 状态：**待评审**（本文只做规划与梳理，未改动任何代码）
> 日期：2026-09-22
> 依据：Apple Human Interface Guidelines 设计原则（Clarity / Deference / Depth + Foundations 各章）
> 与两份代码审计报告（扩展端 options/popup、页内 UI 四处：油猴面板 / 悬浮按钮 / 字幕覆层 / 译文渲染）

---

## 一、参照依据：Apple 的设计原则与理念

### 1.1 总理念

Apple 设计页的总纲是「设计与 Apple 平台**无缝集成**（integrate seamlessly）的应用」——即产品应当看起来、用起来像是平台的一部分，而不是一个外来面板。对本项目的直接含义：**插件 UI 应当像 macOS/Chrome 的原生控件，而不是自成一套的视觉表达。**

### 1.2 三条核心原则（HIG 基石）

| 原则 | Apple 原意 | 落到本项目的判据 |
|---|---|---|
| **Clarity（清晰）** | 文字在任何字号下易读、图标语义明确、控件含义一眼可辨 | 字号必须成体系（不是 11 档随意值）；对比度达标；字重节制；图标/文案无歧义 |
| **Deference（克制/退让）** | 界面服务于内容，不喧宾夺主 | 设置页是工具面板，不应有抢戏的装饰；悬浮钮/字幕不应干扰网页阅读与视频观看 |
| **Depth（层次）** | 用视觉层次与动效传达层级与可操作性 | 阴影/材料/圆角表达"谁浮在谁上面"；动效解释状态变化而非炫技 |

### 1.3 Foundations 各章的可用规则（本项目的检查清单）

| 章节 | Apple 规则 | 本项目对应检查项 |
|---|---|---|
| **Typography** | 优先系统字体（SF Pro / PingFang SC）；使用成体系的 text styles；字重节制（正文 Regular、强调 Semibold）；行高约 1.2–1.5 倍；尊重用户字号设置 | 字号 scale 收敛；系统字体栈；衬线仅作品牌例外；用户字号倍率设置（已有） |
| **Color** | 用语义色（label / secondaryLabel / systemGreen 等），不在组件里写死色值；浅深色模式各自定义且对比度达标（正文 ≥4.5:1，大字/图形 ≥3:1） | 语义 token 化；暗色模式完整；对比度修复清单 |
| **Materials** | 材料（毛玻璃）用于表达层级——浮层/菜单/工具条；克制使用 | 已有 blur 用法（popup 菜单、字幕面板）方向正确，需统一到 token |
| **Layout** | 一致的间距节奏、分组式布局（inset grouped）、安全边距 | 间距回归 4px 网格；卡片/分组统一 |
| **Motion** | 动效服务于层级与反馈、可中断、**尊重"减弱动态效果"** | 时长收敛到 3 档；`prefers-reduced-motion` 全覆盖 |
| **Accessibility** | 一级公民：键盘可达、焦点可见、触达尺寸足够、对比度、动效可关 | 见第五节 A11y 清单（当前缺口最多的一章） |
| **Components** | 同类控件跨界面规格一致（同一 App 内按钮/开关/输入长相相同） | 当前**违反最严重**的一条：四处 UI 各有一套控件 |

> 说明：`developer.apple.com/design/human-interface-guidelines/` 正文为 JS 渲染，抓取仅得到导航结构；上表为 HIG Foundations 的公开内容整理，作为评审基准。
> 关于 WWDC25 的 **Liquid Glass**：属平台新材质语言，对一个"叠加在任意网页之上"的浏览器插件收益有限、成本高，本规划**不引入**（仅建议浮层沿用现有 blur 思路），见第七节。

---

## 二、现状审查结论（代码事实）

### 2.1 一句话诊断

**popup 是完成度最高的一页（单代 macOS 风格 token，干净）；options 设置页是四代设计语言叠加的产物（靠 CSS 源顺序侥幸成立，暗色模式已有实际破损）；页内三处 UI（油猴面板 / 悬浮按钮 / 字幕覆层）各自为政，与设置页不共享任何体系。** 全项目实际存在 5 种"主色"、5 种绿、3 种红、9 档动效时长、8 种圆角值。

### 2.2 核心问题清单（按严重度）

#### A. 功能性破损（必须修）

| # | 问题 | 证据 |
|---|---|---|
| A1 | **暗色模式下 options 主按钮白字白底，不可读**：`background: var(--action-primary)` + `color: #ffffff`，而 dark 下 `--action-primary: #eef1f7` | `options/index.html:886`、`:805` |
| A2 | 暗色下卡片仍是亮色描边 `#e5e7eb`、小按钮仍是纯白块 `#ffffff`、次按钮深字压深底 `#4b535e` | `:842`、`:890`、`:888` |
| A3 | **悬浮按钮键盘完全不可触发**：只监听 `pointerdown/move/up`，无 `click`/`keydown`；Tab 可聚焦、Enter/Space 无效 | `floatingButton.ts:412-414`（全文件 0 处 click/keydown） |
| A4 | options 全页无 `prefers-reduced-motion`（popup 有） | popup 有 `popup/index.html:672-677`；options grep 无 |
| A5 | options 模态框无 Esc 关闭、无焦点陷阱、无初始焦点；且删服务商用原生 `window.confirm`，与自定义 modal 两套并存 | `options/main.ts:168-181`、`:1005` |
| A6 | popup 的楷体标题规则全部空转（`.brand-title/.panel-title/.section-title` 在 DOM 中不存在）→ 品牌标题实际是无衬线 | `popup/index.html:105` vs 实际 DOM `h1` |
| A7 | options 的 webfont 加载被自己覆盖：body 用 `'Source Han Sans SC'`（非加载的 `Noto Sans SC`），Inter/Noto webfont 白加载；`--serif` 变量名与内容矛盾且已无引用（死 token） | `options/index.html:10-11`、`:813`、`:773` |

#### B. 体系性分裂（重构主体）

| # | 问题 | 证据 |
|---|---|---|
| B1 | **options 页叠了 4 层 CSS**：手册 v1.0（黑 accent `#000`）→ 参考稿（蓝 `#1677ff`）→ 墨色阶（`#252a31`）→ 字号字重归一。三套 dark 块同时命中媒体查询，靠源顺序取胜 | `:13-68`、`:69-97`、`:473-496`、`:497-514`、`:740-775`、`:776-811`、`:1057-1096` |
| B2 | 蓝色参考稿残渣仍在生效（选中服务商投影 `rgba(22,119,255,.04)`、`rgba(23,35,54,.03)`） | `:625`、`:608` |
| B3 | **主色 5 版**：options `#252a31` / popup `#0a0a0a` / 油猴面板 `#000000` / 悬浮钮面 `#17171a` / 字幕面板激活 `#3f7a52`（绿） | `OH:754`、`POP:15`、`SP:123`、`FB:96`、`SR:172` |
| B4 | **绿 5 版 / 红 3 版 / 近黑面 3 版** | `#34c759`/`#20b26b`/`#17b26a`/`#3f7a52`/`#35795b`；`#c45c48`/`#b03e2e`(译文错误)/`#b23b31`；`#17171a`/`#1a1a1a`/`rgba(17,17,20,.94)` |
| B5 | **动效 9 档时长 + 5 种缓动**（.12/.15/.16/.18/.2/.22/.24/.25/.4s + 2s 脉冲；Material 曲线 / ease-out / linear / 回弹超冲） | `SR:114,171`、`FB:107,141`、`TR:81`、`SP:128`、`OH:115` |
| B6 | **圆角 8 种值**：7/9/10/11/12/14/16/20；同 modal 内取消钮 9px vs 确认钮 7px；吸附胶囊 10px、字幕状态条 7px、步进钮 6px 全脱标度 | `OH:696,656,831,893,697,842,528`、`FB:150`、`SR:132,180` |
| B7 | **间距无节奏**：options 实际值 13/11/9/18/22/27/30/40/44；声明的 `--space-*` 网格仅被引用 1 次；popup 的 `--radius-*/--space-*` 引用 0 次（死 token） | `OH:647,614,655,636,837`、`OH:158`、`POP:54-55` |
| B8 | **字号 11+ 档**（10.5/11/11.5/12/12.5/13/13.5/14/15.5/16/23）+ 残留合成字重 550/650 | `OH:1057-1096`、`:627,:648,:679,:552,:591` |
| B9 | 油猴面板无暗色模式（全文件无 `prefers-color-scheme`）；token 缺 9 项、`--radius-xl/--shadow-lg` 靠行内 fallback；命名与 options 漂移（`--surface-2` vs `--surface-secondary`、`--danger` vs `--red`） | `SP:116-129,140,142,192,224` |
| B10 | 字幕快捷面板未接入字体栈（`:host{all:initial}` 后回落浏览器默认字体）；开关三套规格（options 38×22 / popup 38×22 / 字幕 36×20），开启色三套 | `SR:86,147,171-174`、`OH:650`、`POP:650` |

#### C. 可访问性缺口（Apple 一级公民章节）

| # | 问题 | 证据 |
|---|---|---|
| C1 | 对比度失败：`--text-3 #999` 白底 ≈2.85:1；状态绿 `#34c759` ≈2.2:1；预览标签 `rgba(255,255,255,.3)` ≈2.4:1；悬浮钮白勾于绿 ≈2.8:1（图形需 3:1） | `SP:121,186,224`、`FB:135,193` |
| C2 | 悬浮钮闲置透明度下限 0.15 → 合成对比 ≈1.4:1，近乎不可见 | `FB:41,109`、`SP:760` |
| C3 | 焦点可见性：油猴面板全文件无 `:focus-visible`（按钮无作者焦点样式）；字幕面板无焦点样式；options 的 `.font-select` 设 `outline:none` 且无 focus 规则 → **键盘聚焦完全不可见**；radio 卡（`opacity:0` 的 input）无 focus-visible | `SP`（无）、`SR`（无）、`OH:903-916`、`OH:255` |
| C4 | ARIA/键盘模式：油猴 tab 无 `role=tablist/tab`、`aria-selected`、方向键；chip/preset 无 `aria-pressed`；模态无 `role=dialog/aria-modal`、不移焦、无焦点圈闭；字幕分段控件无 `aria-pressed`；字幕面板打开不移焦 | `SP:1040-1051,300,722,1023-1068`、`SR:194-198,430-432` |
| C5 | 触达尺寸 <24px：popup 状态按钮 22px、options 开关 22px 高、色板 27px、popup 分段 27px、页脚设置 28px | `POP:626`、`OH:650,931`、`POP:493,649` |
| C6 | 减弱动效未尊重：油猴面板（含 2s 无限脉冲）、悬浮钮（含回弹）、字幕覆层、options 入场动画 | `SP:128,204`、`FB:107,141`、`SR:93,171-173`、`OH:115` |

#### D. 保真度与细节

| # | 问题 | 证据 |
|---|---|---|
| D1 | 油猴面板的样式预览是**手写第二套实现**，已与真实渲染漂移：highlight 预览多 `display:inline-block`（真实为 block 满宽）、underline 预览漏 `padding-block-end` | `SP:666-674` vs `TR:52-65` |
| D2 | 注释与实现脱节：开关注释仍写"48×28 纯黑开启态"，实际 38×22 且色值已变 | `OH:182` vs `:650` |
| D3 | z-index 无体系：options 1000/900/2 vs popup 100/1 | `OH:439,453,595`、`POP:376` |
| D4 | 月白高亮底 `rgba(226,238,241,.9)` 在白页上与背景对比 ≈1.05:1，装饰几乎不可见 | `TR:61` |
| D5 | 译文颜色自适应门槛为背景亮度 `<0.35`，亮度 0.35–0.5 的中浅背景不处理，可能跌到 ≈3.4:1 | `colorReadability.ts:15,90-94`、`TR:121` |
| D6 | 译文与原文**同字重**（直接复制原文 `fontWeight`），层级只靠 0.92 字号与颜色 | `typography.ts:133` |
| D7 | 加载 2 个 CDN webfont（霞鹜文楷、Inter/Noto），离线或 CSP 受限时静默回退，双端表现不一致（油猴端完全没有 webfont） | `OH:10-11`、`POP:10`、`SP:127` |

### 2.3 做对了的部分（重构中必须保留）

- popup 的整体结构：iOS 分组设置行 + 内嵌 hairline、黑药丸主按钮、毛玻璃下拉、roving tabindex 菜单、`aria-live` 状态行、`color-scheme` 反色、`prefers-reduced-motion` —— **这是全项目最接近 Apple 规范的一页**，应作为基准而非重写对象。
- 字幕覆层的"内容优先"处理：描边 + 双层阴影保证任意视频画面上可读、原文 0.85× 层级、Shadow DOM 隔离、CSS 变量热更新 —— 符合 Deference。
- 译文渲染的排版契约（倍率行高、禁字体膨胀、`text-indent:0`、`overflow-wrap`）与 `prefers-reduced-motion` 支持 —— 工程正确性高于视觉，保留。
- 悬浮钮的品牌+徽章状态模型（外观恒定、状态由徽章承载）、贴边胶囊的几何计算 —— 交互设计合理，只需修键盘与对比度。

---

## 三、设计目标与原则映射

### 3.1 本次重构的四条设计契约

1. **一套 token，四处共享**：扩展 options / popup / 油猴面板 / 页内 UI（悬浮钮、字幕、译文）使用同一份设计 token 源，不再各自声明。
2. **控件的规格由 token 决定，不由页面决定**：同一个"开关/按钮/输入框"在任何界面长相一致（Apple Components 章）。
3. **可访问性是完成标准，不是加分项**：键盘可达、焦点可见、对比度达标、减弱动效可关，四项全过才算该组件完成。
4. **内容优先**：叠加在网页/视频上的 UI（悬浮钮、字幕）保持克制——不抢戏、不遮挡、可一键隐去。

### 3.2 问题 → 原则 → 对策 对照

| 现状问题 | 违反的原则 | 对策（详见第四、五节） |
|---|---|---|
| 5 种主色 / 5 种绿 / 3 种红 | Color（语义色）+ Components（一致性） | 单一语义色板：1 强调色 + 3 语义色（成功/危险/警示） |
| 11 档字号 + 合成字重 | Typography（text styles） | 收敛为 6 档 scale，字重限 400/500/600/700 |
| 9 档动效 + 5 种缓动 | Motion | 3 档时长 + 2 条缓动曲线，统一 token |
| 8 种圆角 / 无间距节奏 | Layout | 圆角回到 8/12/16/20 刻度；间距回到 4px 网格 |
| 4 层 CSS 叠加 + 死 token | Clarity（可维护的清晰） | 合并为单一 token 层，删除全部覆盖块与死规则 |
| 暗色破损、油猴面板无暗色 | Color（浅深色成对定义） | 统一 dark token，四处 UI 全覆盖 |
| 键盘不可达 / 焦点不可见 / 对比度失败 | Accessibility | 第六节 A11y 达标清单，逐项验收 |
| 悬浮钮 0.15 透明度 | Deference 的反面（不可发现） | 下限调整 + 悬停全显（见决策点 4） |

---

## 四、目标设计体系（token 规格表）

> 以下为**建议值**，评审通过后写入共享 token 源。

### 4.1 色彩（语义命名，浅深成对）

| 语义 token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--color-canvas` | `#f5f5f7` | `#1c1c1e` | 页面底 |
| `--color-surface` | `#ffffff` | `#2c2c2e` | 卡片/面板 |
| `--color-surface-2` | `#f7f7f8` | `#3a3a3c` | 次级面（输入底、选中态） |
| `--color-label` | `#1d1d1f` | `#f5f5f7` | 主文字 |
| `--color-label-2` | `#555555` | `#aeaeb2` | 次要文字 |
| `--color-label-3` | `#767676`（**由 #999 提升以达 4.5:1**） | `#8e8e93` | 辅助文字 |
| `--color-separator` | `rgba(0,0,0,.08)` | `rgba(255,255,255,.12)` | 分隔线/描边 |
| `--color-accent` | **墨黑 `#111111`**（待拍板，见决策点 1） | `#f5f5f7` | 唯一强调色（按钮/选中/滑杆） |
| `--color-on-accent` | `#ffffff` | `#111111` | 强调色上的文字（**修 A1 的关键**：不再写死白色） |
| `--color-success` | `#1f7a4d`（达 4.5:1） | `#4cd07d` | 成功状态 |
| `--color-danger` | `#b23b31` | `#ff6b5e` | 危险/错误 |
| `--color-warning` | `#8a5a00` | `#ffc453` | 提示（可选） |
| `--color-focus-ring` | `color-mix(accent 35%, transparent)` | 同 | 焦点环 |

**规则**：组件 CSS 中禁止出现字面 HEX（用户可选色板、品牌 logo 色除外）；字幕/悬浮钮属"叠加在任意内容上"的固定深色场景，单独定义 `--overlay-*` 一组，不参与浅深切换（见决策点 4）。

### 4.2 排版

| 角色 | 字号/行高/字重 | 用途 |
|---|---|---|
| `display` | 22 / 1.25 / 700 | 分区大标题（options h2） |
| `title-1` | 17 / 1.3 / 600 | 品牌题签（h1，衬线例外点） |
| `title-2` | 15 / 1.35 / 600 | 面板标题、模态标题 |
| `body` | 13 / 1.5 / 400 | 正文、表单标签、行描述 |
| `caption-1` | 12 / 1.45 / 400 | 辅助说明、状态文字 |
| `caption-2` | 11 / 1.4 / 400 | 极小注释、字数统计 |

- **字体栈统一**：`-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif`（正文）；`--font-display`（霞鹜文楷/楷体栈）**仅**用于 `title-1` 品牌题签与关于页品牌名（品牌例外，符合 HIG "品牌需要时可用自定义字体"）。
- 字重只用 400 / 500 / 600 / 700，删除 550 / 650。
- webfont 策略见决策点 3。

### 4.3 间距 / 圆角 / 阴影 / 层级

| 类别 | 规格 |
|---|---|
| 间距 | 4px 网格：`4 / 8 / 12 / 16 / 20 / 24 / 32 / 40`；组件内边距 8/12/16，区块间距 24/32 |
| 圆角 | `6`（角标/小控件）/ `8`（输入、小按钮）/ `12`（按钮、卡片）/ `16`（面板、模态）/ `20`（外壳） |
| 阴影 | `--elevation-1`（卡片）/ `--elevation-2`（下拉、弹层）/ `--elevation-3`（模态）；叠加型 UI 用"描边 + 更暗面"表达层级（现有字幕面板做法），不依赖阴影 |
| z-index | `--z-content:1 / --z-sticky:10 / --z-overlay:100 / --z-modal:900 / --z-toast:1000`，四处 UI 共用 |

### 4.4 动效

| token | 值 | 用途 |
|---|---|---|
| `--duration-fast` | 120ms | 微反馈（hover、淡入字幕行） |
| `--duration-base` | 200ms | 常规状态切换（按钮、开关、滑杆） |
| `--duration-slow` | 320ms | 入场（面板、模态） |
| `--ease-standard` | `cubic-bezier(.4,0,.2,1)` | 默认 |
| `--ease-out` | `cubic-bezier(.22,1,.36,1)` | 入场/展开 |
| 回弹 | `cubic-bezier(.34,1.56,.64,1)` | **仅**悬浮钮徽章出现（保留为标注例外） |

全部动效包在 `@media (prefers-reduced-motion: no-preference)` 或提供 `reduce` 关闭块——**四处 UI 全覆盖**。

### 4.5 组件规格（跨界面统一）

| 组件 | 规格 | 状态要求 |
|---|---|---|
| 主按钮 | 高 34（页内）/ 46（popup 主行动），圆角 12，accent 底 + `--color-on-accent` 字 | hover / active / focus-visible / disabled / loading |
| 次按钮 | 描边式，圆角 12 | 同上 + active（当前缺） |
| 危险按钮 | `--color-danger`，圆角与同组按钮一致（修 B6） | + disabled（当前缺） |
| 图标按钮 | 32×32，圆角 8 | 同上 |
| 输入/文本域/下拉 | 高 34，圆角 8，focus = accent 边 + 3px focus ring | hover / focus-visible / disabled；**`.font-select` 必须补 focus** |
| 开关 | 38×22 统一（含字幕面板），开 = accent，关 = `--color-surface-2` | hover / focus-visible / disabled |
| 滑杆 | 自绘，拇指 accent | focus-visible / disabled / 边界态 |
| 分段控件 | 高 28，圆角 8，选中 = accent 面 | hover / `aria-pressed` / focus-visible |
| 侧栏导航 | 高 38，圆角 10，选中 = surface-2 + 左强调条 | hover / active / `aria-current` |
| 卡片 | 圆角 16，1px `--color-separator` | — |
| 模态 | 圆角 16，elevation-3 | **Esc 关闭 + 焦点陷阱 + 初始焦点 + 点遮罩关闭**；统一替代 `window.confirm` |
| Toast | 圆角 12，`role=status aria-live=polite` | 补齐 ARIA |
| 叠加型（悬浮钮/字幕） | 见 4.1 `--overlay-*`；字幕面板接入字体栈与圆角刻度 | focus-visible / aria / reduced-motion |

---

## 五、实施阶段划分

> 原则：先修破损（用户可感知的 bug），再统一体系（token），最后精修组件与打磨。每阶段独立可发布、独立可回滚。

### P0 — 破损修复（不动设计体系，纯修 bug）

1. 暗色模式：主按钮白字白底（`--color-on-accent`）、卡片亮描边、小按钮白底、次按钮深字压深底；
2. 悬浮按钮键盘可达：补 `click` + `keydown`(Enter/Space) 处理，长按手势保持 pointer 专属；
3. 模态框：Esc 关闭 + 焦点陷阱 + 初始焦点；删除服务商统一走自定义 modal（去掉 `window.confirm`）；
4. `prefers-reduced-motion`：options 全页补齐（油猴面板、悬浮钮、字幕覆层一并在 P3 覆盖）；
5. 死规则/死 token 清理：popup 楷体空转规则、options `--serif`、字体加载被覆盖（`:813`）；
6. `.font-select` 与 radio 卡补 focus-visible；字幕面板字体接入字体栈。

**验收**：暗色下 options 全部文字可读；纯键盘可完成"翻译当前页 → 还原"；Esc 可关所有模态。

### P1 — 单一 token 源（体系统一）

1. 新建共享 token 源（建议 `chrome-plugin/src/styles/tokens.ts` 导出 CSS 字符串 + `tokens.css` 供 HTML 引用；Shadow DOM 侧复用同一字符串，避免双份维护）；
2. 删除 options 的四层叠加块（保留一层）、清理蓝色残渣与死 token；popup 命名并入统一体系（保留别名兼容）；
3. 四处 UI 接入同一 token：options / popup / 油猴面板 / 悬浮钮 / 字幕 / 译文渲染；
4. 色彩、圆角、间距、动效、z-index 按第四节规格收敛。

**验收**：全项目 grep 无字面 HEX（白名单外）；同一开关/按钮/输入在四个界面视觉一致；油猴面板支持暗色。

### P2 — 组件与排版精修

1. 字号收敛为 6 档、字重限 4 档；删除合成字重；
2. 按钮/开关/滑杆/分段/导航/卡片/模态/Toast 按 4.5 表统一规格与状态；
3. 修正同一模态内按钮圆角不一致、开关注释与实现脱节；
4. 油猴面板样式预览改为复用 `buildMarkerRules`（消除 D1 漂移）。

**验收**：同一组件的四种状态（默认/hover/focus/disabled）齐全；预览与真实渲染逐项一致。

### P3 — 可访问性达标与打磨

1. 对比度：`--color-label-3`、状态绿、徽章白勾、月白高亮底、译文中浅背景区间（D4/D5）逐项修复到 4.5:1（图形 3:1）；
2. ARIA：油猴 tab → `role=tablist/tab` + `aria-selected` + 方向键；chip/preset/分段 → `aria-pressed`；模态 → `role=dialog aria-modal`；悬浮钮 → 补齐键盘语义；
3. 触达尺寸：所有交互目标 ≥24px（触屏场景建议 ≥28px）；
4. 减弱动效：油猴面板（含 2s 脉冲）、悬浮钮、字幕覆层补齐；
5. 悬浮钮闲置透明度下限调整（见决策点 4）。

**验收**：纯键盘走查四处 UI 无死角；对比度检查器全绿；开启系统"减弱动态效果"后无动画。

### 每阶段统一验证

- `npx tsc --noEmit` + `npm test`（374 项）必须全绿；
- options / popup 明暗两套截图核对；
- 真实网页 + YouTube 视频页核对悬浮钮、字幕覆层、译文样式；
- 扩展端与油猴端一致性核对（同一设置项两处长相一致）。

---

## 六、明确不做的事（边界）

1. **不改翻译管线**：`trans.ts` / `service/*` / 消息协议 / 存储键 / 配置字段一律不动（UI 重构只碰表现层）；
2. **不引入 UI 框架**：保持原生 DOM + Shadow DOM（引入框架会破坏油猴端的体积与复用方式）；
3. **不重写 popup 结构**：popup 已是基准，只做 token 接入与细节补齐；
4. **不引入 Liquid Glass 全量材质语言**：浮层沿用现有 blur 思路，不追求平台新视觉的复刻；
5. **不改变 HTML 语义结构**（除必要的 ARIA 属性与类名），避免破坏既有测试与选择器；
6. **不动用户可选色板**：译文颜色/字号等用户设置项的取值域与语义保持不变（只调整默认值与对比度保护逻辑）。

---

## 七、需要你拍板的决策点

| # | 决策 | 我的建议 | 备选 |
|---|---|---|---|
| 1 | **唯一强调色** | **墨黑 `#111111`**：品牌手册 v1.0 定的黑 accent，且油猴面板/popup/悬浮钮已是黑色系，统一成本最低、品牌最一致 | ① Apple 系统蓝 `#007aff`（平台惯例，但与"墨译"品牌调性弱）② 保留 options 现状墨灰 `#252a31` |
| 2 | **衬线题签（霞鹜文楷）去留** | **保留，但仅限品牌题签与关于页**（`title-1`）；正文全部系统无衬线 | ① 全面回归无衬线（最"Apple"）② 完全去掉衬线 |
| 3 | **webfont 策略** | **去掉 CDN webfont，全部走系统字体栈**：零网络请求、离线/受限环境表现一致、油猴端与扩展端统一 | ① 保留 CDN（标题更"品牌"，但离线回退、双端不一致）② 油猴端改用 `@resource` 内嵌（体积 +数百 KB） |
| 4 | **叠加型 UI 的固定深色与透明度** | **保留固定深色**（叠加在任意网页/视频上，深色更克制）；悬浮钮闲置透明度下限 **0.15 → 0.4**，悬停全显 | ① 维持 0.15（可发现性差，对比度不达标）② 下限提到 0.6（更显眼但可能碍眼） |
| 5 | **实施与提交粒度** | **按 P0→P3 四个提交**，每阶段独立可发布，便于你逐个验收 | ① 一次性提交（回归风险集中）② P0+P1 合并（体系统一后再统一验证） |

---

## 八、附录：审计证据索引

| 代号 | 文件 |
|---|---|
| OH | `chrome-plugin/src/entrypoints/options/index.html` |
| OM | `chrome-plugin/src/entrypoints/options/main.ts` |
| POP | `chrome-plugin/src/entrypoints/popup/index.html` |
| SP | `userscript/src/settingsPanel.ts` |
| FB | `chrome-plugin/src/entrypoints/content/floatingButton.ts` |
| SR | `chrome-plugin/src/utils/subtitles/renderer.ts` |
| TR | `chrome-plugin/src/entrypoints/content/translationRenderer.ts` |
| TYPO | `chrome-plugin/src/translation-core/typography.ts` |
| CLR | `chrome-plugin/src/utils/colorReadability.ts` |
