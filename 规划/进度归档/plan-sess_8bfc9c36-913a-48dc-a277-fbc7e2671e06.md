# YouTube 播放器内墨译 Logo 控件 + 快捷面板 — 实施计划

## 一、第一性原理：三层状态模型

控件的生命周期 ≠ 字幕覆盖层的生命周期（这是陪读蛙验证过的核心设计）。拆为三层：

1. **功能总门** `config.enabled`（设置页）：false 时整个特性休眠——字幕、面板、logo 都不出现；
2. **运行时暂停** `paused`（新概念，sessionStorage 键 `moyi-yt-subtitle-paused`）：logo 电源键切换。暂停后字幕行隐藏、恢复 YouTube 原生 CC、调度停摆；但宿主与 logo 保留（变暗 + OFF 角标），随时一键恢复。同标签页刷新后仍记住（sessionStorage 特性）；
3. **面板开合** `panelOpen`（纯内存态）：点 logo 展开/收起；点外部、Esc、SPA 导航时关闭。

## 二、参考实现映射（陪读蛙实证 → 我们的 vanilla TS 架构）

| 陪读蛙做法 | 我们的落地 |
|---|---|
| 入口按钮塞进 `.ytp-right-controls`（依赖 YT DOM） | 改挂**自己的字幕 Shadow 宿主内**：字幕区上方右侧小徽标（零依赖、全屏天然存活） |
| ON/OFF 徽标 + 变暗 | 同款：logo 角标 OFF 态 + 不透明度降低 |
| 面板渲染在字幕同一 Shadow 宿主内 | 同款（我们本来就单宿主） |
| `.ytp-autohide` 类观察 + 进度条高度测量 | 同款 MutationObserver；面板 bottom = 控制条可见 ? 高度+18 : 22px；**顺带把字幕整体在控制条出现时上抬**，避免遮挡 |
| 外部 pointerdown(capture+composedPath) + Esc 关闭 | 同款 |
| 运行时可见性原子（非全局配置） | `paused` 运行时变量 + sessionStorage |

## 三、实施内容

### 渲染层 renderer.ts（扩展，约 +260 行）
- Shadow markup 新增两层：**logo 徽标**（32×32 半透明圆角底 + 复用 floatLogo 图像，`pointer-events:auto`，hover 提亮，暂停时 OFF 角标变暗）与**快捷面板**（默认隐藏；右下深色毛玻璃卡片，头部标题+×；电源开关行；显示模式三选段控；字号 −/数值px/+ 行（14–36，步长 2）；底部「更多设置 →」）；
- 控制条同步：对播放器容器建 class 属性 MutationObserver（`.ytp-autohide`）+ 测 `.ytp-progress-bar-container` 高度，驱动面板偏移与字幕整体上抬；
- 新 API：`bindControlCallbacks({onTogglePause,onSetMode,onFontSizeDelta,onOpenSettings})`、`setPausedVisual(paused)`、`setPanelState(...)`（storage 热更后刷新面板显示）、`closePanel()`；
- 关闭监听：document pointerdown（capture，composedPath 判定 panel/chip 外部）+ Escape，mount 注册 / unmount 移除。

### 引擎层 youtube.content.ts（约 +90 行）
- `paused` 初值读 sessionStorage；`syncNow` 入口处 paused 直接短路（清空显示）；电源回调切换 paused、持久化、暂停侧 `scheduler.reset()` 清在途批次、恢复侧重启 syncNow;
- 模式/字号回调：读最新 `getSubtitleConfig()` → 改字段 → `saveSubtitleConfig()`（现有 storage.onChanged 管线自动热更新渲染，字号清洗兜底边界）；「更多设置」→ `chrome.runtime.openOptionsPage()`；
- `config.enabled=false` 分支维持全卸载语义（总门）；SPA teardown 时面板态一并重置。

### 测试（新增约 80 行）
- 纯函数：`computePanelBottomOffset(controlsVisible,height)`、字号步进边界钳制、面板外部点击判定谓词；
- 回归：compile/test 全绿；构建同步 dist；油猴产物哈希复验不变。

## 四、明确不做（本轮）
- 颜色/描边/阴影/字体的面板内调节（留设置页，面板保持紧凑）；拖拽定位；Shorts/embed 支持；快捷键切换。