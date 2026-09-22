## 背景

「墨译」扩展目前没有任何位图 logo：工具栏是 Chrome 默认拼图，popup/options 品牌位和网页悬浮球都是 CSS 文字字形（墨/译），翻译状态靠整球变绿 + 白点提示。`log/` 下两个新 logo（圆角矩形版、圆形版，1254×1254）尚未接入。

**资产已生成完毕**（进入计划模式前已完成，可直接使用）：
- `scripts/gen-assets.mjs` — 资产生成脚本（sharp）：单一来源 `log/*.png` → 所有尺寸
- `src/public/icon/{16,32,48,128}.png` — 圆角矩形主 logo 的标准图标尺寸
- `src/entrypoints/content/floatLogo.ts` — 圆形 logo 烘焙 alpha 后内联为 data URI（72px @2x，9KB）

## 第一性原理设计依据

1. **图标的本质 = 最小尺寸下的可识别性**：16px 下需要高对比、单主体。圆角矩形是应用图标的标准形状（工具栏/商店/设置页视觉一致）→ 主 logo 全部用圆角矩形版。
2. **悬浮球的本质 = 叠加在任意网页上的临时控件**：圆形无方向性、与任何页面内容冲突最小；36px 下的文字「译」辨识度低且与品牌脱钩 → 换成圆形品牌图。
3. **翻译状态辨识的本质 = 无须阅读即可判断**：绿色对号是跨文化通用语义；徽章叠加而非替换按钮外观——品牌恒定，状态由徽章承载（沉浸式翻译同款交互）。
4. **悬浮球图用 data URI 内联**：悬浮球代码被扩展与油猴脚本共用，油猴访问不了 `chrome-extension://` 资源，data URI 是唯一双宿主通行的形式。

## 实施步骤

### 1. wxt.config.ts — 声明图标
manifest 增加：
```ts
icons: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
action: { ..., default_icon: { 同上映射 } }
```

### 2. popup/index.html — 头部品牌位
- `<div class="app-icon">墨</div>` → `<img class="app-icon" src="/icon/128.png" alt="">`
- `.app-icon` 样式去掉背景/字色/字体，保留 38px 尺寸。

### 3. options/index.html — 两处品牌位
- 侧栏 `.app-icon`（约 L1024）和关于页 `.about-brand-icon`（约 L1380）同样换成 `<img src="/icon/128.png">`
- 该文件有多层主题 CSS 都给 `.app-icon` 设了背景色（会从 PNG 透明角透出），在样式表末尾追加一条覆盖规则：`img.app-icon, img.about-brand-icon { background: none !important; box-shadow: none !important; }`

### 4. floatingButton.ts — 悬浮球改造（核心）
- 引入 `FLOAT_LOGO_DATA_URI`，标记改为：
```html
<button class="fab">
  <img class="logo" alt="" src={dataURI}>
  <span class="hint" aria-hidden="true"></span>
  <span class="badge" aria-hidden="true"><svg>白色对号</svg></span>
</button>
```
- **logo 图**：`width/height:100%; object-fit:cover; border-radius:inherit` —— 非吸附态随容器呈正圆；贴边吸附态（24×36 胶囊、radius 10px）自动中心裁切成长条切片，无需 overflow:hidden（否则会剪掉徽章的出界部分）。
- **绿色对号徽章**（沉浸式翻译样式）：右下角 14px 绿色圆（鲜绿 #17b26a 一类）+ 白描边圈 + 白色对号 SVG；默认 `opacity:0 scale(.5)`，`.fab.translated` 时弹入。移除旧的白色状态点 `.dot` 和整体变绿背景（状态信息全部交给徽章）。
- **吸附箭头**：原 `.label::before/::after` 的 ‹ › 移到 `.hint` 上，仅吸附态显示，白字加轻微投影保证在图上可读。
- **状态同步重构**：`syncState` 与导出的 `syncFloatingButtonState` 抽取共用 `applyFabState()`，切换 `.translated` 类 + aria-label + title 提示（悬停显示「移除译文」，弥补去掉「还」字后的语义线索）。拖拽/吸附逻辑不动。

### 5. userscript/src/settingsPanel.ts — 页内设置面板（网页内悬浮窗口 → 圆形）
- 头部 `el('span', {class:'logo', text:'译'})` → `el('img', {class:'logo', src: FLOAT_LOGO_DATA_URI})`
- `.logo` CSS 改为 26px 圆形图。

### 6. tests/floating-button.test.ts
- 默认态断言：aria-label「翻译当前页」+ `img.logo` 存在且 src 为 data URI；删掉 `.label` 文本断言
- 翻译态断言：`.translated` 类 + aria-label「移除译文」+ 徽章存在
- 拖拽/吸附相关测试不变

### 7. 构建验证
- `npm run build` → 确认产物 manifest.json 含 icons 字段、icon/*.png 已拷贝
- `npm test` 全绿
- 目检 16/48px 图标清晰度（必要时调生成参数）
- `npm run build:userscript` 确认油猴包正常

不改动：`github-upload/`（旧快照副本）、`transform-html.cjs`（一次性宣传页脚本）。