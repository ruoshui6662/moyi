/**
 * 字幕覆盖层渲染：挂在播放器容器（.html5-video-player）内部，
 * 全屏/影院模式自动生效；open Shadow DOM 承载样式，页面 CSS 与
 * 整页翻译的 TreeWalker 均无法触达内部文本。
 *
 * 样式全部经 CSS 自定义属性注入：配置热更新只改变量，不重建节点。
 */

import {
  SUBTITLE_FONT_SIZE_MAX,
  SUBTITLE_FONT_SIZE_MIN,
  type SubtitleConfig,
  type SubtitleDisplayMode,
} from './config';
import { FLOAT_LOGO_DATA_URI } from '../../entrypoints/content/floatLogo';

const HOST_ID = 'moyi-yt-subtitles-host';
const NATIVE_HIDE_STYLE_ID = 'moyi-yt-hide-native-captions';
/** 注入 YouTube 控制条的 logo 按钮宿主 id（放在原生 CC 键旁）。 */
const CONTROL_CHIP_ID = 'moyi-yt-control-chip';

/** 阴影强度 [0,1] → text-shadow 声明（纯函数，测试与预览复用）。 */
export const buildShadowCss = (intensity: number): string => {
  if (typeof intensity !== 'number' || !Number.isFinite(intensity) || intensity <= 0) return 'none';
  const level = Math.min(1, intensity);
  return [
    `0 1px 2px rgba(0, 0, 0, ${(0.45 + 0.45 * level).toFixed(2)})`,
    `0 0 ${(3 + 7 * level).toFixed(1)}px rgba(0, 0, 0, ${(0.35 + 0.55 * level).toFixed(2)})`,
  ].join(', ');
};

/** 原文行相对译文字号的缩放比：原文行始终随译文字号联动。 */
export const ORIGINAL_LINE_RATIO = 0.85;

/** 描边宽度 ≈ 字号的 4.5%，最小 1px（纯函数，测试与预览复用）。 */
export const buildStrokeWidthPx = (fontSize: number): number => {
  if (typeof fontSize !== 'number' || !Number.isFinite(fontSize)) return 1;
  return Math.max(1, Math.round(fontSize * 0.045 * 100) / 100);
};

/** 面板底部偏移：控制条可见时抬到其上方 18px，否则贴底留 22px 呼吸位。 */
export const computePanelBottomOffset = (controlsVisible: boolean, controlsHeight: number): number => {
  const safeHeight = Number.isFinite(controlsHeight) && controlsHeight > 0 ? controlsHeight : 0;
  return controlsVisible ? safeHeight + 18 : 22;
};

/**
 * 控制层高度的兜底值：DOM 结构变化导致测不到时按典型控制条高度处理，
 * 宁可多让位也不能盖住原生控件。
 */
export const CONTROLS_CHROME_DEFAULT_HEIGHT = 60;

/** 测量播放器完整控制层高度（含按键排）：进度条的父元素即全宽控制层 .ytp-chrome-bottom。
 * 只量进度条会漏掉约 48px 的按键排——那正是面板盖住设置/画质按钮的原因。 */
const measureControlsChromeHeight = (container: HTMLElement): number => {
  const progressBar = container.querySelector('.ytp-progress-bar-container');
  const controlsBar = progressBar instanceof Element ? progressBar.parentElement : null;
  const measured = controlsBar?.getBoundingClientRect().height ?? 0;
  return measured > 0 ? measured : CONTROLS_CHROME_DEFAULT_HEIGHT;
};

/** 面板内字号步进：加 delta 后钳制到配置合同区间 [MIN,MAX]。 */
export const clampStepFontSize = (fontSize: number, delta: number): number => {
  const base = Number.isFinite(fontSize)
    ? fontSize
    : (SUBTITLE_FONT_SIZE_MIN + SUBTITLE_FONT_SIZE_MAX) / 2;
  return Math.min(SUBTITLE_FONT_SIZE_MAX, Math.max(SUBTITLE_FONT_SIZE_MIN, Math.round(base + delta)));
};

/** 外部点击判定：事件路径不含面板与徽标时视为外部（应关闭面板）。 */
export const isDismissTarget = (path: EventTarget[], panel: Element | null, chip: Element | null): boolean =>
  !path.some((node) => node === panel || node === chip);

/** 快捷面板回调契约：引擎注入实现，渲染层只管 UI 与事件转发。 */
export interface PlayerControlCallbacks {
  /** 电源键：切换会话级暂停。 */
  onTogglePause: () => void;
  /** 显示模式切换。 */
  onSetMode: (mode: SubtitleDisplayMode) => void;
  /** 字号步进（±px）。 */
  onFontSizeDelta: (delta: number) => void;
}

const SHADOW_MARKUP = `
<style>
  :host { all: initial; }
  .wrap {
    position: absolute;
    left: 0;
    right: 0;
    /* 控制条出现时整体上抬，避免字幕被 YouTube 进度条遮挡 */
    bottom: calc(9% + var(--moyi-sub-controls-h, 0px));
    transition: bottom 0.15s ease;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.35em;
    padding: 0 5%;
    text-align: center;
    pointer-events: none;
    font-family: var(--moyi-sub-font-family, 'Roboto', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif);
  }
  .line {
    max-width: 100%;
    color: var(--moyi-sub-color, #ffffff);
    font-size: var(--moyi-sub-font-size, 22px);
    line-height: 1.4;
    font-weight: 500;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    text-shadow: var(--moyi-sub-shadow, none);
    opacity: 0;
    transition: opacity 0.12s ease;
  }
  .line.on { opacity: 1; }
  .line.original {
    /* 与 ORIGINAL_LINE_RATIO 保持一致：原文行随译文字号等比联动 */
    font-size: calc(var(--moyi-sub-font-size, 22px) * 0.85);
    font-weight: 400;
  }
  .line.original.on { opacity: 0.85; }
  .line.translation {
    -webkit-text-stroke-color: var(--moyi-sub-stroke-color, rgba(0, 0, 0, 0));
    -webkit-text-stroke-width: var(--moyi-sub-stroke-width, 0px);
    paint-order: stroke fill;
  }
  .status {
    display: none;
    max-width: 80%;
    padding: 6px 14px;
    border-radius: 7px;
    background: rgba(0, 0, 0, 0.62);
    color: #f1f1f1;
    font-size: 14px;
    line-height: 1.5;
    text-shadow: none;
  }
  .status.on { display: block; }
  /* 显示模式：仅译文中隐藏原文行；仅原文中隐藏译文行 */
  .wrap.mode-translation .line.original,
  .wrap.mode-original .line.translation { display: none; }
  /* ── 快捷面板（入口在控制条原生字幕键旁，面板本体仍挂字幕宿主内以存活全屏）── */
  .panel {
    display: none;
    position: absolute;
    right: var(--moyi-sub-panel-right, 16px);
    bottom: var(--moyi-sub-panel-offset, 22px);
    width: 236px;
    padding: 12px 14px 10px;
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(17, 17, 20, 0.94);
    backdrop-filter: blur(10px);
    color: #e8e8ea;
    font-size: 13px;
    line-height: 1.4;
    text-align: left;
    pointer-events: auto;
    z-index: 4;
  }
  .panel.open { display: block; }
  .panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .panel-title { font-size: 13px; font-weight: 600; color: #fff; }
  .panel-close { border: 0; background: transparent; color: #9a9aa2; font-size: 16px; line-height: 1; cursor: pointer; padding: 2px 4px; }
  .panel-close:hover { color: #fff; }
  .panel-head ~ .panel-row,
  .panel-head ~ .panel-col { border-top: 1px solid rgba(255, 255, 255, 0.07); }
  .panel-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 0; }
  .panel-col { display: flex; flex-direction: column; gap: 2px; padding: 7px 0; }
  .panel-label { color: #c9c9cf; }
  .power { position: relative; width: 36px; height: 20px; border-radius: 10px; border: 0; background: #4a4a52; cursor: pointer; transition: background 0.15s ease; padding: 0; flex: none; }
  .power[aria-checked='true'] { background: #3f7a52; }
  .power::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: left 0.15s ease; }
  .power[aria-checked='true']::after { left: 18px; }
  .seg { display: flex; border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 8px; overflow: hidden; width: 100%; margin-top: 6px; }
  .seg button { flex: 1; padding: 5px 0; border: 0; background: transparent; color: #b9b9c0; font-size: 12px; cursor: pointer; }
  .seg button.active { background: rgba(63, 122, 82, 0.55); color: #fff; }
  .seg button + button { border-left: 1px solid rgba(255, 255, 255, 0.1); }
  .stepper { display: flex; align-items: center; gap: 8px; }
  .stepper button { width: 24px; height: 24px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.16); background: rgba(255, 255, 255, 0.06); color: #eee; font-size: 14px; line-height: 1; cursor: pointer; }
  .stepper button:hover { background: rgba(255, 255, 255, 0.14); }
  .size-val { min-width: 44px; text-align: center; font-variant-numeric: tabular-nums; color: #fff; }
</style>
<div class="wrap mode-bilingual">
  <div class="line translation"></div>
  <div class="line original"></div>
  <div class="status"></div>
</div>
<div class="panel" part="panel">
  <div class="panel-head"><span class="panel-title">墨译字幕</span><button class="panel-close" type="button" aria-label="关闭面板">×</button></div>
  <div class="panel-row"><span class="panel-label">显示字幕</span><button class="power" type="button" role="switch" aria-checked="true" aria-label="显示或暂停字幕"></button></div>
  <div class="panel-col">
    <span class="panel-label">显示模式</span>
    <div class="seg">
      <button type="button" data-mode="bilingual">双语</button>
      <button type="button" data-mode="translation">仅译文</button>
      <button type="button" data-mode="original">仅原文</button>
    </div>
  </div>
  <div class="panel-row"><span class="panel-label">字号</span><div class="stepper">
    <button type="button" data-step="-2" aria-label="减小字号">−</button>
    <span class="size-val">22px</span>
    <button type="button" data-step="2" aria-label="增大字号">＋</button>
  </div></div>
</div>`;

export class SubtitleRenderer {
  private host: HTMLElement | null = null;
  /** 原挂载容器：退出全屏时把覆层移回此处。 */
  private container: HTMLElement | null = null;
  private wrap: HTMLDivElement | null = null;
  private originalLine: HTMLDivElement | null = null;
  private translationLine: HTMLDivElement | null = null;
  private statusLine: HTMLDivElement | null = null;
  // ── 播放器控件层（控制条 logo 按钮 + 快捷面板）──
  private callbacks: PlayerControlCallbacks | null = null;
  private panelEl: HTMLDivElement | null = null;
  private powerBtn: HTMLButtonElement | null = null;
  private sizeVal: HTMLSpanElement | null = null;
  private segButtons: HTMLButtonElement[] = [];
  private controlsObserver: MutationObserver | null = null;
  private pausedState = false;
  /** 注入到 .ytp-right-controls 的按钮宿主（独立 shadow root，随控制条显隐）。 */
  private controlChipHost: HTMLElement | null = null;
  private controlBtn: HTMLButtonElement | null = null;
  private reinsertObserver: MutationObserver | null = null;

  private handleOutsidePointer = (event: PointerEvent): void => {
    if (!this.panelEl?.classList.contains('open')) return;
    // 入口按钮自身不判为外部：否则 pointerdown 先关、click 再开，面板永远关不上
    if (isDismissTarget(event.composedPath(), this.panelEl, this.controlChipHost)) this.closePanel();
  };

  private handlePanelKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.closePanel();
  };

  /** 控制条显隐同步：YouTube 以 .ytp-autohide 标记隐藏；非 YouTube 站点（如 X）无此几何，贴底留呼吸位。 */
  private syncControlsOffset = (): void => {
    const container = this.host?.parentElement;
    if (!container) return;
    const isYoutubeControls = container.classList.contains('ytp-autohide')
      || Boolean(container.querySelector('.ytp-progress-bar-container'))
      || Boolean(container.querySelector('.ytp-right-controls'));
    if (isYoutubeControls) {
      const controlsVisible = !container.classList.contains('ytp-autohide');
      const chromeHeight = controlsVisible ? measureControlsChromeHeight(container) : 0;
      this.host?.style.setProperty('--moyi-sub-controls-h', `${Math.round(chromeHeight)}px`);
      this.host?.style.setProperty('--moyi-sub-panel-offset', `${computePanelBottomOffset(controlsVisible, chromeHeight)}px`);
      this.host?.style.setProperty('--moyi-sub-panel-right', `${controlsVisible ? 88 : 16}px`);
      return;
    }
    // 非 YouTube：不假定原生控制条几何，面板与字幕都贴底留呼吸位
    this.host?.style.setProperty('--moyi-sub-controls-h', '0px');
    this.host?.style.setProperty('--moyi-sub-panel-offset', '22px');
    this.host?.style.setProperty('--moyi-sub-panel-right', '16px');
  };

  get isMounted(): boolean {
    return this.host !== null;
  }

  /** 宿主是否仍连接在 DOM：站点（如 X）用 React 重渲染播放器会摘除已挂载节点。 */
  get hostConnected(): boolean {
    return this.host?.isConnected ?? false;
  }

  /** 挂载到播放器容器；重复调用会先清理旧实例（扩展重载自愈同 floatingButton 策略）。 */
  mount(container: HTMLElement): void {
    const existing = document.getElementById(HOST_ID);
    if (existing && existing !== this.host) existing.remove();

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:9999;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = SHADOW_MARKUP;

    this.host = host;
    this.container = container;
    this.wrap = shadow.querySelector('.wrap');
    this.originalLine = shadow.querySelector('.line.original');
    this.translationLine = shadow.querySelector('.line.translation');
    this.statusLine = shadow.querySelector('.status');
    this.panelEl = shadow.querySelector('.panel');
    this.powerBtn = shadow.querySelector('.power');
    this.sizeVal = shadow.querySelector('.size-val');
    this.segButtons = Array.from(shadow.querySelectorAll<HTMLButtonElement>('.seg [data-mode]'));
    this.wireControlEvents();
    container.appendChild(host);

    this.syncControlsOffset();
    this.controlsObserver = new MutationObserver(() => this.syncControlsOffset());
    this.controlsObserver.observe(container, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('resize', this.syncControlsOffset);
    document.addEventListener('pointerdown', this.handleOutsidePointer, true);
    window.addEventListener('keydown', this.handlePanelKeydown);
    document.addEventListener('fullscreenchange', this.handleFullscreenChange);
    this.mountControlBarButton(container);
  }

  /**
   * 全屏跟随：进入全屏时把覆层移入 document.fullscreenElement 子树，
   * 退出时移回原挂载容器。站点（如 X）的全屏目标若不是挂载容器，
   * 覆层会被排除在全屏渲染树外而消失——此监听让覆层始终在全屏元素内。
   * YouTube 的全屏目标即挂载容器，fsEl.contains(host) 为真，不移动（幂等无害）。
   */
  private handleFullscreenChange = (): void => {
    const fsEl = document.fullscreenElement as HTMLElement | null;
    if (!this.host) return;
    if (fsEl) {
      if (!fsEl.contains(this.host)) {
        try {
          fsEl.appendChild(this.host);
        } catch {
          // 全屏元素为 <video> 等替换元素时 appendChild 抛错或子节点不渲染，忽略
        }
        this.syncControlsOffset();
      }
    } else if (this.container && !this.container.contains(this.host)) {
      this.container.appendChild(this.host);
      this.syncControlsOffset();
    }
  };

  unmount(): void {
    this.controlsObserver?.disconnect();
    this.controlsObserver = null;
    this.reinsertObserver?.disconnect();
    this.reinsertObserver = null;
    this.controlChipHost?.remove();
    this.controlChipHost = null;
    this.controlBtn = null;
    window.removeEventListener('resize', this.syncControlsOffset);
    document.removeEventListener('pointerdown', this.handleOutsidePointer, true);
    window.removeEventListener('keydown', this.handlePanelKeydown);
    document.removeEventListener('fullscreenchange', this.handleFullscreenChange);
    this.callbacks = null;
    this.panelEl = null;
    this.powerBtn = null;
    this.sizeVal = null;
    this.segButtons = [];
    this.host?.remove();
    this.host = null;
    this.container = null;
    this.wrap = null;
    this.originalLine = null;
    this.translationLine = null;
    this.statusLine = null;
    this.setNativeCaptionsHidden(false);
  }

  /** 应用样式配置：只改 CSS 变量与模式类，不重建节点。 */
  applyConfig(config: SubtitleConfig): void {
    if (!this.wrap) return;
    this.wrap.classList.remove('mode-bilingual', 'mode-translation', 'mode-original');
    this.wrap.classList.add(`mode-${config.displayMode}`);
    this.wrap.style.setProperty('--moyi-sub-color', config.color);
    this.wrap.style.setProperty('--moyi-sub-font-size', `${Math.round(config.fontSize)}px`);
    this.wrap.style.setProperty('--moyi-sub-shadow', buildShadowCss(config.shadowIntensity));
    this.wrap.style.setProperty('--moyi-sub-stroke-color', config.strokeColor);
    this.wrap.style.setProperty('--moyi-sub-stroke-width', `${buildStrokeWidthPx(config.fontSize)}px`);
    // 用户字体栈非空则覆盖默认栈；为空移除变量回落到 CSS 兜底链
    if (config.fontFamily.trim()) {
      this.wrap.style.setProperty('--moyi-sub-font-family', config.fontFamily.trim());
    } else {
      this.wrap.style.removeProperty('--moyi-sub-font-family');
    }
    this.setNativeCaptionsHidden(config.hideNativeCaptions);
  }

  /** 显示当前 cue；原文/译文传 null 表示该行隐藏。两者皆 null = 字幕间隙。 */
  show(original: string | null, translation: string | null): void {
    if (!this.originalLine || !this.translationLine) return;
    this.toggleStatus(false);
    this.setLine(this.originalLine, original);
    this.setLine(this.translationLine, translation);
  }

  /** 会话级提示（无字幕/获取失败等），显示期间压过字幕行。 */
  setStatus(message: string | null): void {
    if (!this.statusLine) return;
    if (message) {
      this.statusLine.textContent = message;
      this.statusLine.classList.add('on');
      this.setLine(this.originalLine, null);
      this.setLine(this.translationLine, null);
    } else {
      this.toggleStatus(false);
    }
  }

  private toggleStatus(on: boolean): void {
    this.statusLine?.classList.toggle('on', on);
  }

  private setLine(line: HTMLDivElement | null, text: string | null): void {
    if (!line) return;
    line.textContent = text ?? '';
    line.classList.toggle('on', typeof text === 'string' && text.length > 0);
  }

  /** 隐藏/恢复 YouTube 原生字幕（注入带 id 的全局样式，幂等）。 */
  setNativeCaptionsHidden(hidden: boolean): void {
    if (hidden && !document.getElementById(NATIVE_HIDE_STYLE_ID)) {
      const style = document.createElement('style');
      style.id = NATIVE_HIDE_STYLE_ID;
      style.textContent = '.ytp-caption-window-container{display:none!important;}';
      document.head.appendChild(style);
    } else if (!hidden) {
      document.getElementById(NATIVE_HIDE_STYLE_ID)?.remove();
    }
  }

  /** 注入控件回调（mount 前后调用均可，事件转发时按需取用）。 */
  bindControlCallbacks(callbacks: PlayerControlCallbacks): void {
    this.callbacks = callbacks;
  }

  /** 会话暂停视觉：控制条按钮变暗 + OFF 角标 + 面板电源键状态。 */
  setPausedVisual(paused: boolean): void {
    this.pausedState = paused;
    this.controlBtn?.classList.toggle('paused', paused);
    this.powerBtn?.setAttribute('aria-checked', String(!paused));
  }

  /** storage 热更后同步面板显示（模式选中态/字号数值/电源态）。 */
  setPanelState(displayMode: SubtitleDisplayMode, fontSize: number, paused: boolean): void {
    this.setPausedVisual(paused);
    for (const button of this.segButtons) {
      button.classList.toggle('active', button.dataset.mode === displayMode);
    }
    if (this.sizeVal) this.sizeVal.textContent = `${Math.round(fontSize)}px`;
  }

  closePanel(): void {
    this.panelEl?.classList.remove('open');
  }

  /** 面板/事件只挂一次；回调经 bindControlCallbacks 注入，允许后绑定。 */
  private ensureControlChip(container: HTMLElement): void {
    if (this.controlChipHost?.isConnected) return;
    if (!this.host?.isConnected) return;
    const rightControls = container.querySelector('.ytp-right-controls');

    // 非 YouTube 站点（如 X）：无原生控制条可挂，退化为浮在视频右上角的常驻入口，
    // 点击展开字幕面板（电源/模式/字号）。这是「字幕开关」在非 YouTube 站点的唯一入口。
    if (!rightControls) {
      const floatHost = document.createElement('div');
      floatHost.id = CONTROL_CHIP_ID;
      // 左上角：避开 X 右上角关闭/全屏键与底部播放控件条——这两个区域恰是 X chrome 占位，
      // 之前放右上/右下都被覆盖；左上是 X 视频上的空区，与字幕同宿主同层叠上下文，字幕可见则开关可见
      floatHost.style.cssText = 'position:absolute;top:10px;left:10px;z-index:6;pointer-events:auto;';
      const shadow = floatHost.attachShadow({ mode: 'open' });
      // 纯 CSS 绘制（文字「译」+ 实心圆底），不用 data: 图标，绕开 X 的 img-src CSP
      shadow.innerHTML = `
        <style>
          :host { all: initial; }
          .btn { display:flex; align-items:center; justify-content:center; width:34px; height:34px; border-radius:50%; border:0; background:rgba(0,0,0,0.62); color:#fff; font-size:15px; font-weight:700; font-family:sans-serif; cursor:pointer; opacity:0.92; padding:0; box-shadow:0 1px 5px rgba(0,0,0,0.45); }
          .btn:hover { opacity:1; background:rgba(0,0,0,0.8); }
          .btn.paused { opacity:0.4; }
        </style>
        <button class="btn" type="button" aria-label="墨译字幕面板" title="墨译字幕">译</button>`;
      shadow.querySelector('.btn')?.addEventListener('click', () => {
        this.panelEl?.classList.toggle('open');
      });
      this.host.appendChild(floatHost);
      this.controlChipHost = floatHost;
      this.controlBtn = shadow.querySelector('.btn');
      if (this.pausedState) this.controlBtn?.classList.add('paused');
      return;
    }

    const host = document.createElement('div');
    host.id = CONTROL_CHIP_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    // 样式对齐 YouTube 控制条按键：等高居中、hover 提亮；暂停时变暗并显示 OFF 角标
    shadow.innerHTML = `
      <style>
        :host { all: initial; display: flex; height: 100%; align-items: center; }
        .btn { position: relative; display: flex; width: 44px; height: 100%; align-items: center; justify-content: center; background: transparent; border: 0; cursor: pointer; opacity: 0.85; padding: 0; }
        .btn:hover { opacity: 1; }
        .btn img { width: 22px; height: 22px; display: block; pointer-events: none; }
        .btn.paused { opacity: 0.45; }
        .badge { display: none; position: absolute; top: 3px; right: 2px; min-width: 22px; padding: 0 3px; border-radius: 4px; background: #3a3a3f; color: #ddd; font-size: 8px; line-height: 13px; text-align: center; font-family: sans-serif; }
        .btn.paused .badge { display: block; }
      </style>
      <button class="btn" type="button" aria-label="墨译字幕面板" title="墨译字幕">
        <img src="${FLOAT_LOGO_DATA_URI}" alt="" draggable="false" />
        <span class="badge">OFF</span>
      </button>`;
    shadow.querySelector('.btn')?.addEventListener('click', () => {
      this.panelEl?.classList.toggle('open');
    });
    // 固定在原生 CC 键旁；无 CC 键的视频退化为右键簇首位
    const ccButton = rightControls.querySelector('.ytp-subtitles-button');
    if (ccButton && ccButton.parentElement === rightControls) ccButton.after(host);
    else rightControls.prepend(host);

    this.controlChipHost = host;
    this.controlBtn = shadow.querySelector('.btn');
    if (this.pausedState) this.controlBtn?.classList.add('paused');
  }

  /** 注入控制条按钮，并在 YouTube 重建控制条 DOM 时自动补插。 */
  private mountControlBarButton(container: HTMLElement): void {
    this.ensureControlChip(container);
    this.reinsertObserver?.disconnect();
    this.reinsertObserver = new MutationObserver(() => {
      if (this.controlChipHost && !this.controlChipHost.isConnected) {
        this.ensureControlChip(container);
      }
    });
    this.reinsertObserver.observe(container, { childList: true, subtree: true });
  }

  /** 面板/徽标事件只挂一次；回调经 bindControlCallbacks 注入，允许后绑定。 */
  private wireControlEvents(): void {
    this.panelEl?.querySelector('.panel-close')?.addEventListener('click', () => this.closePanel());
    this.powerBtn?.addEventListener('click', () => this.callbacks?.onTogglePause());
    for (const button of this.segButtons) {
      button.addEventListener('click', () => {
        const mode = button.dataset.mode;
        if (mode === 'bilingual' || mode === 'translation' || mode === 'original') {
          this.callbacks?.onSetMode(mode);
        }
      });
    }
    this.panelEl?.querySelectorAll<HTMLButtonElement>('[data-step]').forEach((button) => {
      button.addEventListener('click', () => {
        const delta = Number(button.dataset.step);
        if (Number.isFinite(delta)) this.callbacks?.onFontSizeDelta(delta);
      });
    });
  }
}
