/**
 * 可移动悬浮按钮：固定在页面角落，可拖拽移位；点击翻译/还原（由宿主决定动作）。
 *
 * 品牌与状态（参考沉浸式翻译悬浮球）：
 *   - 按钮本体是圆形品牌 logo 图（floatLogo.ts 内联 data URI，扩展/油猴双宿主通用），
 *     圆形无方向性，叠加在任何网页上都和谐；
 *   - 翻译状态由右下角绿色对号徽章承载：品牌外观恒定，状态信息独立、无须阅读即可辨识；
 *   - 悬停按钮显示 title 提示（翻译当前页 / 移除译文）。
 *
 * 边缘吸附：
 *   - 拖到左/右边缘释放 → 按钮贴边停靠为一个紧凑胶囊（24px 宽、带箭头提示），
 *     logo 以 object-fit:cover 中心裁切成条状切片，主体仍在视口内、始终可见；
 *   - 悬停胶囊自动展开为完整按钮，点击触发动作，按住可重新拖动；
 *   - 没有继续位移的点击仍视为点击动作。
 *
 * 定位模型：非吸附态统一使用 `left + top` 锚点；吸附态用边界锚定
 * （dock-left 用 left:0，dock-right 用 right:0），垂直位置始终用 top。
 *
 * 稳定性原则：
 *   - shadow DOM 承载样式，页面 CSS 无法覆盖按钮外观；
 *   - 只通过 options 回调触发动作，不直接改动翻译管线；
 *   - 拖动与点击以位移阈值区分，避免拖拽误触发翻译；
 *   - 位置与吸附状态仅持久化到 chrome.storage.local 独立键，不污染插件配置。
 */

import { FLOAT_LOGO_DATA_URI } from './floatLogo';

export const FLOAT_HOST_ID = 'moyi-float-control';
export const FLOAT_POSITION_KEY = 'moyi-float-position';

const DRAG_THRESHOLD_PX = 4;
/**
 * 主按钮直径：可点击性与遮挡度的权衡变量，最终由用户在设置中裁决
 * （config.floatSize 经宿主传入；此处常量仅作缺省与防御边界）。
 */
export const FLOAT_SIZE_DEFAULT = 32;
export const FLOAT_SIZE_MIN = 26;
export const FLOAT_SIZE_MAX = 48;
/** 闲置态不透明度缺省值；交互（悬停/按下）时自动全显，保证操作瞬间清晰。 */
export const FLOAT_OPACITY_DEFAULT = 0.9;
export const FLOAT_OPACITY_MIN = 0.15;
export const FLOAT_OPACITY_MAX = 1;
/** 吸附停靠时胶囊宽度（贴边、始终可见）。 */
const DOCK_SIZE = 24;
/** 距视口边缘不超过此距离释放即吸附（小于默认停靠间距，避免初始位置误触）。 */
const DOCK_THRESHOLD_PX = 10;

export type FloatDock = 'left' | 'right' | null;

/** 悬浮按钮外观：直径（px）与闲置态不透明度。 */
export interface FloatAppearance {
  size: number;
  opacity: number;
}

export interface FloatingButtonOptions {
  /** 当前页面是否已渲染译文（切换按钮语义与外观）。 */
  isTranslated: () => boolean;
  /** 点击触发：由宿主分发「翻译当前页 / 还原」。 */
  onToggle: () => void | Promise<void>;
  /** 长按触发（可选）：油猴脚本用它打开页内设置面板；扩展不传，行为不变。 */
  onLongPress?: () => void;
  /** 初始外观（可选）：缺省用 FLOAT_SIZE_DEFAULT / FLOAT_OPACITY_DEFAULT。 */
  appearance?: FloatAppearance;
}

/** 长按判定时长：超过即视为长按手势。 */
const LONG_PRESS_MS = 600;

export interface FloatPosition {
  x: number;
  y: number;
  dock: FloatDock;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const DEFAULT_GAP = 16;

const buildShadowMarkup = (): string => `
  <style>
    :host { all: initial; }
    .fab {
      position: fixed;
      left: ${DEFAULT_GAP}px;
      top: ${DEFAULT_GAP}px;
      z-index: 2147483000;
      /* 大小与透明度由 CSS 变量驱动：设置变更时仅更新变量，几何/吸附计算同步用同值 */
      width: var(--moyi-fab-size, 32px);
      height: var(--moyi-fab-size, 32px);
      margin: 0;
      padding: 0;
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 50%;
      background: #17171a;
      /* 悬浮阴影：贴地接触阴影 + 环境扩散阴影，形成浮起感；悬停加深 */
      box-shadow:
        0 2px 5px -2px rgba(0, 0, 0, 0.28),
        0 10px 22px -10px rgba(0, 0, 0, 0.4);
      cursor: grab;
      user-select: none;
      -webkit-user-select: none;
      touch-action: none;
      /* 初始不可见：先按默认位挂载、异步恢复存储位置后再淡入，避免「默认位闪现」 */
      opacity: 0;
      transition: width 0.18s ease, border-radius 0.18s ease, opacity 0.22s ease, box-shadow 0.18s ease;
    }
    .fab.ready { opacity: var(--moyi-fab-opacity, 0.9); }
    .fab:active { cursor: grabbing; }
    /* 交互瞬间全显：半透明只为阅读时不碍眼，操作时刻必须清晰 */
    .fab:hover,
    .fab:active { opacity: 1; }
    .fab:hover { box-shadow: 0 4px 9px -3px rgba(0, 0, 0, 0.3), 0 18px 34px -12px rgba(0, 0, 0, 0.5); }
    /* 品牌 logo：随容器形状裁切（正圆 ↔ 吸附胶囊），cover 保证吸附变窄时不拉伸变形 */
    .logo {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
      border-radius: inherit;
      pointer-events: none;
      transition: border-radius 0.18s ease;
    }
    /* 翻译状态徽章：绿色对号（参考沉浸式翻译），白色描边圈保证在任意页面底色上可辨 */
    .badge {
      position: absolute;
      right: -3px;
      bottom: -3px;
      width: 15px;
      height: 15px;
      display: grid;
      place-items: center;
      border-radius: 50%;
      background: #17b26a;
      box-shadow:
        0 0 0 2px rgba(255, 255, 255, 0.92),
        0 1px 3px rgba(0, 0, 0, 0.35);
      opacity: 0;
      transform: scale(0.4);
      transition: opacity 0.16s ease, transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
      pointer-events: none;
    }
    .badge svg { width: 9px; height: 9px; display: block; }
    .fab.translated .badge { opacity: 1; transform: scale(1); }
    /* 吸附停靠：贴边紧凑胶囊，主体始终在视口内可见 */
    .fab.docked-left,
    .fab.docked-right {
      width: ${DOCK_SIZE}px;
      border-radius: 10px;
      cursor: pointer;
    }
    /* 悬停展开为完整按钮 */
    .fab.docked-left:hover,
    .fab.docked-right:hover {
      width: var(--moyi-fab-size, 32px);
      border-radius: 50%;
    }
    /* 箭头指示可展开方向：覆盖在 logo 切片上，加投影保证可读 */
    .hint {
      position: absolute;
      inset: 0;
      display: none;
      align-items: center;
      color: #ffffff;
      font-size: 11px;
      font-weight: 700;
      line-height: 1;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.55);
      pointer-events: none;
    }
    .fab.docked-left .hint,
    .fab.docked-right .hint { display: flex; }
    .fab.docked-left .hint { justify-content: flex-start; padding-left: 4px; }
    .fab.docked-left .hint::before { content: '‹'; }
    .fab.docked-right .hint { justify-content: flex-end; padding-right: 4px; }
    .fab.docked-right .hint::after { content: '›'; }
    /* 吸附态徽章略缩小，避免喧宾夺主 */
    .fab.docked-left .badge,
    .fab.docked-right .badge {
      right: -4px;
      bottom: -4px;
      width: 12px;
      height: 12px;
    }
    @media print {
      .fab { display: none !important; }
    }
  </style>
  <button class="fab" type="button" aria-label="翻译当前页" title="翻译当前页">
    <img class="logo" alt="" draggable="false" src="${FLOAT_LOGO_DATA_URI}">
    <span class="hint" aria-hidden="true"></span>
    <span class="badge" aria-hidden="true"><svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.6 6.4l2.4 2.4 4.4-5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
  </button>
`;

const readStoredPosition = async (): Promise<FloatPosition | null> => {
  try {
    const stored = await chrome.storage.local.get(FLOAT_POSITION_KEY);
    const value = stored[FLOAT_POSITION_KEY] as FloatPosition | undefined;
    if (!value) return null;
    if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
    return { x: value.x, y: value.y, dock: value.dock === 'left' || value.dock === 'right' ? value.dock : null };
  } catch {
    return null;
  }
};

const persistPosition = async (position: FloatPosition): Promise<void> => {
  try {
    await chrome.storage.local.set({ [FLOAT_POSITION_KEY]: position });
  } catch {
    // 持久化失败不影响本次会话的按钮位置
  }
};

/** closed shadow 下 host.shadowRoot 对外不可达，模块内登记表供状态同步与测试查询。 */
const shadowRoots = new WeakMap<HTMLElement, ShadowRoot>();
/** 外观应用器登记表：配置热同步时按 host 定位到已挂载实例。 */
const appearanceAppliers = new WeakMap<HTMLElement, (appearance: Partial<FloatAppearance>) => void>();

/** 查询按钮本身（closed shadow 下只能经模块内登记表访问）。 */
export const getFloatFab = (host: HTMLElement | null): HTMLButtonElement | null => {
  if (!host) return null;
  return shadowRoots.get(host)?.querySelector<HTMLButtonElement>('.fab') ?? null;
};

/**
 * 运行时更新已挂载悬浮按钮的外观（大小/透明度）；host 未挂载时静默跳过。
 * 配置热同步路径：storage.onChanged → main.refreshConfig → 本函数，
 * 设置面板拖动滑杆即刻生效，无须刷新页面。
 */
export const applyFloatAppearance = (appearance: Partial<FloatAppearance>): void => {
  const host = document.getElementById(FLOAT_HOST_ID);
  if (!host) return;
  appearanceAppliers.get(host)?.(appearance);
};

/** 翻译状态 → 按钮外观：徽章显隐 + 无障碍标签与悬停提示（弥补去掉「还」字后的语义线索）。 */
const applyFabState = (fab: HTMLButtonElement, translated: boolean): void => {
  fab.classList.toggle('translated', translated);
  const label = translated ? '移除译文' : '翻译当前页';
  fab.setAttribute('aria-label', label);
  fab.setAttribute('title', label);
};

export const mountFloatingButton = (options: FloatingButtonOptions): (() => void) => {
  // 接管自愈：扩展重载后 content script 会重新注入，此时旧 host 的 DOM 可能仍残留在页面
  // （其 JS 上下文已随旧扩展实例销毁，事件全部失效）。发现残留必须先移除再重建，
  // 否则短路返回会留下无事件、状态错乱的僵尸按钮，表现为「重载后看不到/点不动」。
  const existing = document.getElementById(FLOAT_HOST_ID);
  if (existing) existing.remove();

  const host = document.createElement('div');
  host.id = FLOAT_HOST_ID;
  host.style.cssText = 'all: initial; position: static;';

  // closed 模式：页面脚本无法经 host.shadowRoot 触达按钮
  const shadow = host.attachShadow({ mode: 'closed' });
  shadowRoots.set(host, shadow);
  shadow.innerHTML = buildShadowMarkup();
  const fab = shadow.querySelector<HTMLButtonElement>('.fab')!;

  // ── 外观状态：尺寸同时驱动 CSS 与几何 clamp，保证吸附/拖拽边界随设置收敛 ──
  // （dock 须先于初始 applyAppearance 声明：尺寸收敛分支依赖它）
  let dock: FloatDock = null;
  let currentSize = clamp(
    Math.round(options.appearance?.size ?? FLOAT_SIZE_DEFAULT),
    FLOAT_SIZE_MIN,
    FLOAT_SIZE_MAX,
  );
  let currentOpacity = clamp(
    options.appearance?.opacity ?? FLOAT_OPACITY_DEFAULT,
    FLOAT_OPACITY_MIN,
    FLOAT_OPACITY_MAX,
  );

  const applyAppearance = (next: Partial<FloatAppearance>): void => {
    if (next.size !== undefined) {
      currentSize = clamp(Math.round(next.size), FLOAT_SIZE_MIN, FLOAT_SIZE_MAX);
      fab.style.setProperty('--moyi-fab-size', `${currentSize}px`);
      // 尺寸变化后重新收敛位置：非吸附态按新直径夹回视口
      if (!dock) {
        const left = Number.parseFloat(fab.style.left);
        const top = Number.parseFloat(fab.style.top);
        if (Number.isFinite(left)) fab.style.left = `${clamp(left, 0, window.innerWidth - currentSize)}px`;
        if (Number.isFinite(top)) fab.style.top = `${clamp(top, 0, window.innerHeight - currentSize)}px`;
      }
    }
    if (next.opacity !== undefined) {
      currentOpacity = clamp(next.opacity, FLOAT_OPACITY_MIN, FLOAT_OPACITY_MAX);
      fab.style.setProperty('--moyi-fab-opacity', String(currentOpacity));
    }
  };
  appearanceAppliers.set(host, applyAppearance);
  applyAppearance({ size: currentSize, opacity: currentOpacity });

  // ── 吸附状态：非吸附用 left+top；吸附用边界锚定（left/right=0）+ top ──
  // （dock 的声明已上移至外观状态之前，此处仅保留锚定逻辑）

  const applyDock = (next: FloatDock, baseX: number): void => {
    dock = next;
    fab.classList.toggle('docked-left', next === 'left');
    fab.classList.toggle('docked-right', next === 'right');
    if (next === 'left') {
      fab.style.left = '0px';
      fab.style.right = 'auto';
      fab.style.top = `${anchorY}px`;
    } else if (next === 'right') {
      fab.style.right = '0px';
      fab.style.left = 'auto';
      fab.style.top = `${anchorY}px`;
    } else {
      fab.style.right = 'auto';
      fab.style.left = `${clamp(baseX, 0, window.innerWidth - currentSize)}px`;
      fab.style.top = `${anchorY}px`;
    }
  };

  // 拖拽状态
  let dragging = false;
  let dragged = false;
  let startX = 0;
  let startY = 0;
  let baseLeft = 0;
  let baseTop = 0;
  let lastDragLeft = 0;
  let anchorY = 0;

  // 长按手势：仅当宿主提供 onLongPress 时启用；移动或提前松开即取消
  let pressTimer: number | undefined;
  let longPressFired = false;

  const cancelLongPress = (): void => {
    if (pressTimer !== undefined) {
      window.clearTimeout(pressTimer);
      pressTimer = undefined;
    }
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    dragging = true;
    dragged = false;
    startX = event.clientX;
    startY = event.clientY;
    // 按下即解除吸附，恢复完整尺寸跟随拖动
    if (dock) applyDock(null, lastDragLeft);
    const rect = fab.getBoundingClientRect();
    baseLeft = rect.left;
    baseTop = rect.top;
    lastDragLeft = baseLeft;
    if (typeof fab.setPointerCapture === 'function') fab.setPointerCapture(event.pointerId);
    if (options.onLongPress) {
      longPressFired = false;
      cancelLongPress();
      pressTimer = window.setTimeout(() => {
        pressTimer = undefined;
        longPressFired = true;
        options.onLongPress?.();
      }, LONG_PRESS_MS);
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX) {
      dragged = true;
      cancelLongPress();
    }
    if (dragged) {
      const nextLeft = clamp(baseLeft + dx, 0, window.innerWidth - currentSize);
      lastDragLeft = nextLeft;
      fab.style.right = 'auto';
      fab.style.left = `${nextLeft}px`;
      fab.style.top = `${clamp(baseTop + dy, 0, window.innerHeight - currentSize)}px`;
    }
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    cancelLongPress();
    if (typeof fab.hasPointerCapture === 'function' && fab.hasPointerCapture(event.pointerId)) {
      fab.releasePointerCapture(event.pointerId);
    }
    // 长按已触发动作时吞掉本次释放，避免再叠加「点击翻译」
    if (longPressFired) {
      longPressFired = false;
      return;
    }
    if (dragged) {
      anchorY = Math.round(parseFloat(fab.style.top) || 0);
      const distanceToLeft = lastDragLeft;
      const distanceToRight = window.innerWidth - (lastDragLeft + currentSize);
      if (distanceToLeft <= DOCK_THRESHOLD_PX) {
        applyDock('left', lastDragLeft);
        void persistPosition({ x: lastDragLeft, y: anchorY, dock: 'left' });
      } else if (distanceToRight <= DOCK_THRESHOLD_PX) {
        applyDock('right', lastDragLeft);
        void persistPosition({ x: lastDragLeft, y: anchorY, dock: 'right' });
      } else {
        void persistPosition({ x: lastDragLeft, y: anchorY, dock: null });
      }
      return;
    }
    void options.onToggle();
  };

  fab.addEventListener('pointerdown', onPointerDown);
  fab.addEventListener('pointermove', onPointerMove);
  fab.addEventListener('pointerup', onPointerUp);

  // 恢复持久化位置与吸附状态（y 为 top 坐标），完成后淡入按钮。
  // 先按默认位挂载、恢复完统一 .ready，杜绝「左上角闪现→跳到存储位」的跳变。
  const restore = (position: FloatPosition): void => {
    lastDragLeft = position.x;
    anchorY = position.y;
    fab.style.left = `${clamp(position.x, 0, window.innerWidth - currentSize)}px`;
    fab.style.top = `${clamp(position.y, 0, window.innerHeight - currentSize)}px`;
    applyDock(position.dock, position.x);
  };
  void readStoredPosition().then((position) => {
    if (position) restore(position);
    fab.classList.add('ready');
  });

  const syncState = (): void => {
    applyFabState(fab, options.isTranslated());
  };

  document.documentElement.appendChild(host);
  syncState();

  return () => {
    cancelLongPress();
    fab.removeEventListener('pointerdown', onPointerDown);
    fab.removeEventListener('pointermove', onPointerMove);
    fab.removeEventListener('pointerup', onPointerUp);
    host.remove();
  };
};

/** 供宿主在译文节点增删后同步按钮状态（配合 MutationObserver）。 */
export const syncFloatingButtonState = (options: FloatingButtonOptions): void => {
  const host = document.getElementById(FLOAT_HOST_ID);
  if (!host) return;
  const shadow = shadowRoots.get(host);
  if (!shadow) return;
  const fab = shadow.querySelector<HTMLButtonElement>('.fab');
  if (!fab) return;
  applyFabState(fab, options.isTranslated());
};