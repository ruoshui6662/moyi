/**
 * 划词查词卡：closed Shadow DOM 浮层（宿主模式与悬浮球/字幕覆层同源）。
 *
 * 设计约束：
 * - 插件独有：经 entrypoints/selection.content.ts 挂载，油猴 import 图不触及（红线）；
 * - 样式走 OVERLAY_TOKENS_CSS 固定深色（与字幕/悬浮球同一视觉族，叠加在任意页面上自洽）；
 * - 定位复用 popupMenuPosition 的上下择优逻辑 + 水平夹取，绝不出视口；
 * - 关闭途径三件套：Esc、点外部（capture + composedPath 判宿主）、页面滚动/缩放即时收起
 *   （不做跟随重定位——选区锚点会随布局漂移，收起比错位更诚实）；
 * - 宿主常驻、内容切换 hidden：避免每次划词重建 shadow 树，收起后零视觉残留。
 */

import { GLASS_OVERLAY_CSS, OVERLAY_FONT_STACK } from '../../styles/overlayTokens';
import { computeMenuPlacement } from '../../utils/popupMenuPosition';
import { MAX_LOOKUP_CHARS, type ExplainLevel, type ExplainResult, type LookupResult } from '../../utils/selectionLookup';
import { clampToViewport, type CardPosition } from '../../utils/cardPosition';

export const SELECTION_HOST_ID = 'moyi-selection-card';

const CARD_WIDTH = 320;
const CARD_MARGIN = 8;
const CARD_MAX_BODY_HEIGHT = 240;

const esc = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const buildCardMarkup = (): string => `
  <style>
    :host { all: initial; ${GLASS_OVERLAY_CSS} }
    .card {
      position: fixed;
      z-index: 2147483001;
      box-sizing: border-box;
      width: ${CARD_WIDTH}px;
      max-width: calc(100vw - ${CARD_MARGIN * 2}px);
      /* 液态玻璃：半透明面 + 强模糊 + 饱和度提升；滤镜不支持时底色更实，可读性不塌 */
      background: var(--moyi-glass-bg);
      -webkit-backdrop-filter: blur(var(--moyi-glass-blur)) saturate(180%);
      backdrop-filter: blur(var(--moyi-glass-blur)) saturate(180%);
      color: var(--moyi-glass-label);
      border: 1px solid var(--moyi-glass-border);
      border-radius: var(--moyi-glass-radius);
      /* 边缘只留「一道」：外框亮边 + 顶部镜面高光。
         早期版本还叠了一圈内嵌深色描边（inset ring），与外框亮边叠在一起
         视觉上读成「两层卡叠边」——液态玻璃的边缘靠模糊边界+高光，不是双描边。 */
      box-shadow:
        var(--moyi-glass-shadow),
        inset 0 1px 0 var(--moyi-glass-specular);
      font-family: ${OVERLAY_FONT_STACK};
      font-size: 13px;
      line-height: 1.55;
      letter-spacing: -0.006em;
      padding: 13px 15px;
      overflow: hidden;
      user-select: text;
      -webkit-user-select: text;
    }
    /* 顶部光泽：玻璃受光的关键细节，渐隐到卡片中部 */
    .card::before {
      content: '';
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: linear-gradient(180deg, var(--moyi-glass-sheen), transparent 44%);
    }
    .card > * { position: relative; }
    .card { cursor: default; touch-action: none; }
    .card.dragging { cursor: grabbing; }
    .card * { cursor: inherit; }
    .card input, .card textarea { cursor: text; }
    .close {
      position: absolute; top: 8px; right: 8px; z-index: 2;
      width: 22px; height: 22px; padding: 0; line-height: 1;
      display: grid; place-items: center; font-size: 11px;
    }
    /* 玻璃控件：半透明填充 + 系统蓝焦点环（键盘可达性） */
    .card button {
      background: var(--moyi-glass-fill);
      border: none;
      color: var(--moyi-glass-label-2);
      font: inherit;
      font-size: 11.5px;
      padding: 2px 9px;
      border-radius: 999px;
      cursor: pointer;
      transition: background-color var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard);
    }
    .card button:hover:not(:disabled) { background: var(--moyi-glass-fill-hover); color: var(--moyi-glass-label); }
    .card button:focus-visible { outline: 2px solid var(--moyi-glass-accent); outline-offset: 2px; }
    .card button:disabled { opacity: 0.45; cursor: default; }
    .card[hidden] { display: none; }
    /* 叉号绝对定位于右上：正文首行预留其宽度，长文本自动换行而不被压字 */
    .body > :first-child { padding-right: 26px; }
    .head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
    .term { font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
    .phonetic { color: var(--moyi-glass-label-2); font-size: 12px; }
    .pos {
      color: var(--moyi-glass-label-2); font-size: 11px;
      border: 1px solid var(--moyi-glass-edge); border-radius: 999px; padding: 0 7px;
    }
    .translation { margin-top: 6px; font-weight: 600; }
    .definition { margin-top: 6px; color: var(--moyi-glass-label); }
    .example { margin-top: 6px; color: var(--moyi-glass-label-2); font-style: italic; }
    /* ── 阅读卡深究态（Explain + 追问）── */
    .deep-btn { margin-top: 9px; font-size: 11.5px; }
    .save.saved, .speak.playing { color: var(--moyi-glass-success); }
    .deep-panel { margin-top: 8px; border-top: 1px solid var(--moyi-glass-edge); padding-top: 8px; }
    .deep-panel[hidden] { display: none; }
    .deep-levels { display: flex; gap: 6px; margin-bottom: 8px; }
    .deep-levels button { flex: none; font-size: 11.5px; }
    .deep-levels button.active { color: var(--moyi-glass-bg); background: var(--moyi-glass-label); }
    .deep-block { margin-top: 6px; }
    .deep-block .label { color: var(--moyi-glass-label-2); font-size: 11px; }
    .deep-block .value { color: var(--moyi-glass-label); white-space: pre-wrap; }
    .deep-thread { margin-top: 8px; max-height: 160px; overflow: auto; border-top: 1px solid var(--moyi-glass-edge); padding-top: 8px; }
    .deep-thread[hidden] { display: none; }
    .deep-q { color: var(--moyi-glass-label-2); font-size: 12px; margin-top: 6px; }
    .deep-a { color: var(--moyi-glass-label); margin-top: 2px; white-space: pre-wrap; }
    .deep-ask { margin-top: 8px; display: flex; gap: 6px; }
    .deep-ask input {
      flex: 1; min-width: 0; background: var(--moyi-glass-fill); color: var(--moyi-glass-label);
      border: 1px solid var(--moyi-glass-border); border-radius: var(--moyi-glass-radius-sm);
      padding: 5px 9px; font: inherit; font-size: 12px; outline: none;
    }
    .deep-ask input::placeholder { color: var(--moyi-glass-label-3); }
    .deep-ask input:focus { border-color: var(--moyi-glass-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--moyi-glass-accent) 24%, transparent); }
    .deep-ask input:focus { border-color: var(--moyi-glass-label-2); }
    .deep-ask button { flex: none; background: var(--moyi-glass-fill); color: var(--moyi-glass-label); font-size: 11.5px; padding: 4px 12px; }
    .status { color: var(--moyi-glass-label-2); }
    .status.error { color: var(--moyi-glass-danger); font-style: normal; }
    /* 底部分隔线改虚线（实线在小卡片上过于生硬） */
    .foot { margin-top: 9px; padding-top: 7px; border-top: 1px dashed var(--moyi-glass-border); font-size: 11px; color: var(--moyi-glass-label-2); }
    .actions { display: flex; flex-wrap: nowrap; gap: 8px; justify-content: flex-end; }
    .save.saved { color: var(--moyi-glass-success); }
    @media print { .card { display: none !important; } }
    @media (prefers-reduced-motion: reduce) { .card, .card * { transition: none !important; animation: none !important; } }
  </style>
  <div class="card" hidden role="dialog" aria-label="划词查词">
    <button class="close" type="button" title="关闭（Esc）" aria-label="关闭">✕</button>
    <div class="body"><div class="status">翻译中…</div></div>
    <button class="deep-btn" type="button" hidden>详解</button>
    <div class="deep-panel" hidden>
      <div class="deep-levels">
        <button type="button" data-level="beginner">入门</button>
        <button type="button" data-level="intermediate" class="active">进阶</button>
        <button type="button" data-level="advanced">母语</button>
      </div>
      <div class="deep-result"><div class="status">点击上方难度开始讲解</div></div>
      <div class="deep-thread" hidden></div>
      <div class="deep-ask">
        <input class="deep-input" type="text" placeholder="继续追问，如「这里的虚拟语气是什么意思」" />
        <button class="deep-send" type="button" disabled>追问</button>
      </div>
    </div>
    <div class="foot"><span class="actions"><button class="copy" type="button" title="复制结果">复制</button><button class="speak" type="button" title="朗读译文" disabled>朗读</button><button class="save" type="button" title="加入生词本">收藏</button></span></div>
  </div>
`;

export interface SelectionCardAnchor {
  /** 选区外接矩形（视口坐标）。 */
  rect: { top: number; bottom: number; left: number; right: number };
}

/** 收藏所需的出处信息（宿主在触发时捕获）。 */
export interface SelectionCardMeta {
  /** 本次查询词：结果未到时供朗读/收藏回退。 */
  query?: string;
  context: string;
  pageTitle: string;
  url: string;
}

export interface SelectionCardOptions {
  onExternalPointerDown?: () => void;
  /** 收藏请求：解析成功返回 true（按钮转「已收藏」并禁用）。 */
  /** 收藏：查询未出结果时 result 为 null（词条先存原词，出结果后可回填译名）。 */
  onSave?: (result: LookupResult | null, meta: SelectionCardMeta | null) => Promise<boolean>;
  /** 朗读译文（无译文时读释义或原词）。 */
  /** 朗读：text + 来源（译文/释义/原词）——来源决定用目标语言音色还是按内容探测。 */
  onSpeak?: (text: string, kind: 'translation' | 'definition' | 'query') => void;
  /** 朗读停止（卡片关闭/新查询时调用，避免悬空播报）。 */
  onStopSpeak?: () => void;
  /** 阅读卡：请求讲解（详解按钮或切换难度时触发）。 */
  onDeepRequest?: (level: ExplainLevel) => void;
  /** 阅读卡：提交追问（question 已 trim 非空）。 */
  onAsk?: (question: string) => void;
  /** 用户点卡片 ✕ 关闭（与 Esc/点外部区分：宿主据此清理悬停状态，同词可再触发）。 */
  onManualClose?: () => void;
  /** 拖拽落点变化：宿主按站点持久化（下一会话同站直接回到此处）。 */
  onPositionChange?: (position: CardPosition) => void;
  /** 双击复位：宿主清除该站点的记忆位置。 */
  onPositionReset?: () => void;
  /** 启动时注入该站点的记忆位置（null = 无）。 */
  initialPosition?: CardPosition | null;
}

export interface SelectionCard {
  /** 在锚点处显示卡片（loading 态）；meta 为收藏出处信息。 */
  open(loadingText: string, anchor: SelectionCardAnchor, meta?: SelectionCardMeta): void;
  render(result: LookupResult, state?: { collected?: boolean }): void;
  showError(message: string): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
  /** 直接以一条提示打开卡片（超长选段等「不该静默」的场景）。 */
  openNotice(message: string, anchor: SelectionCardAnchor, meta?: SelectionCardMeta): void;
  /** 指针是否落在卡片矩形内（±6px 容差）——closed shadow 无法用 target 判定，悬停粘滞靠它。 */
  isPointerInside(x: number, y: number): boolean;
  /** 深究态：进入面板并展示加载态。 */
  showDeepLoading(label: string): void;
  renderDeep(result: ExplainResult): void;
  showDeepError(message: string): void;
  /** 追加一轮问答（entry 侧持有会话历史，关卡即弃）。 */
  appendExchange(question: string, answer: string): void;
  /** 追问输入可用性（请求在途时禁用，防连发）。 */
  setAskEnabled(enabled: boolean): void;
}

/**
 * 卡片几何：**选区侧边优先**——用户反馈「弹窗遮挡正文」。
 * 依次尝试 右侧 → 左侧 → 下方 → 上方，取第一个放得下的位置（右侧最自然：
 * 词卡在词的一侧，不压住刚选中的内容，也符合原生 popover 的心智）。
 * 返回绝对坐标（left/top 均为像素），便于与「位置记忆」对齐。
 */
export const computeCardPlacement = (
  rect: SelectionCardAnchor['rect'],
  viewportW: number,
  viewportH: number,
  cardHeight: number,
  cardWidth = CARD_WIDTH,
): { left: number; top: number; side: 'right' | 'left' | 'below' | 'above' } => {
  const width = Math.min(cardWidth, viewportW - CARD_MARGIN * 2);
  const height = Math.min(cardHeight, viewportH - CARD_MARGIN * 2);
  const gap = CARD_MARGIN + 2;
  const verticallyFits = (top: number): boolean => top >= CARD_MARGIN && top + height <= viewportH - CARD_MARGIN;

  // ① 右侧：与选区垂直居中对齐
  const rightLeft = Math.max(CARD_MARGIN, rect.right + gap); // 选区贴屏幕左缘时也不能让卡片压到视口边
  if (rightLeft + width <= viewportW - CARD_MARGIN) {
    const top = Math.max(CARD_MARGIN, Math.min(rect.top + (rect.bottom - rect.top - height) / 2, viewportH - height - CARD_MARGIN));
    if (verticallyFits(top)) return { left: rightLeft, top, side: 'right' };
  }
  // ② 左侧
  const leftLeft = rect.left - gap - width;
  if (leftLeft >= CARD_MARGIN) {
    const top = Math.max(CARD_MARGIN, Math.min(rect.top + (rect.bottom - rect.top - height) / 2, viewportH - height - CARD_MARGIN));
    if (verticallyFits(top)) return { left: leftLeft, top, side: 'left' };
  }
  // ③ 下方（水平对齐选区左缘）
  const belowTop = rect.bottom + gap;
  if (belowTop + height <= viewportH - CARD_MARGIN) {
    return { left: Math.max(CARD_MARGIN, Math.min(rect.left, viewportW - width - CARD_MARGIN)), top: belowTop, side: 'below' };
  }
  // ④ 上方兜底
  return {
    left: Math.max(CARD_MARGIN, Math.min(rect.left, viewportW - width - CARD_MARGIN)),
    top: Math.max(CARD_MARGIN, rect.top - gap - height),
    side: 'above',
  };
};

/** 触发规则判定：返回可查询文本，null = 不弹卡。长度上限与 background 侧共用常量，
 *  避免两处各写一份上限而漂移（真机教训：卡片 200 / 后台 200 时长选段被误杀）。 */
export const resolveLookupTrigger = (
  selectionText: string,
  context: { enabled: boolean; insideEditable: boolean; insideOwnUi: boolean },
): string | null => {
  if (!context.enabled || context.insideEditable || context.insideOwnUi) return null;
  const collapsed = selectionText.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  if (collapsed.length > MAX_LOOKUP_CHARS) return null; // 整页级拖选：不值得为它花一次补全
  return collapsed;
};

/** 编辑区判定：输入框/文本域/可编辑元素内的划词不触发（写作场景 ≠ 阅读场景）。 */
export const isEditableTarget = (node: Node | null): boolean => {
  const element = node?.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node?.parentElement ?? null;
  const closest = element?.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]');
  return Boolean(closest);
};

/** closed shadow 下宿主内部不可达；模块内登记表供状态同步与测试查询（floatingButton 同款）。 */
const shadowRoots = new WeakMap<HTMLElement, ShadowRoot>();
/** 仅供单元测试穿透 closed shadow 检查按钮状态；生产代码禁止使用。 */
export const getSelectionCardShadowForTest = (host: HTMLElement): ShadowRoot | null =>
  shadowRoots.get(host) ?? null;

/** 朗读来源优先级：**译文 → 释义 → 原词**（用户要求先读翻译后的语言）。
 *  类型随来源返回：译文/释义属目标语言，用目标音色；原词是回退，按内容探测音色。 */
export const resolveSpeakSource = (
  result: LookupResult | null,
  meta: SelectionCardMeta | null,
): { text: string; kind: 'translation' | 'definition' | 'query' } => {
  if (result?.translation) return { text: result.translation, kind: 'translation' };
  if (result?.definition) return { text: result.definition, kind: 'definition' };
  const query = meta?.query ?? result?.term ?? '';
  return { text: query, kind: 'query' };
};

export const mountSelectionCard = (options?: SelectionCardOptions): SelectionCard => {
  if (document.getElementById(SELECTION_HOST_ID)) {
    throw new Error(`划词宿主已存在：#${SELECTION_HOST_ID}`);
  }
  const host = document.createElement('div');
  host.id = SELECTION_HOST_ID;
  host.style.cssText = 'all: initial; position: static;';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = buildCardMarkup();
  document.documentElement.appendChild(host);
  shadowRoots.set(host, shadow);
  const card = shadow.querySelector<HTMLElement>('.card')!;
  const body = shadow.querySelector<HTMLElement>('.body')!;
  const copyButton = shadow.querySelector<HTMLButtonElement>('.copy')!;
  const saveButton = shadow.querySelector<HTMLButtonElement>('.save')!;
  const speakButton = shadow.querySelector<HTMLButtonElement>('.speak')!;
  const deepBtn = shadow.querySelector<HTMLButtonElement>('.deep-btn')!;
  const deepPanel = shadow.querySelector<HTMLElement>('.deep-panel')!;
  const deepLevelButtons = Array.from(shadow.querySelectorAll<HTMLButtonElement>('.deep-levels button'));
  const deepResult = shadow.querySelector<HTMLElement>('.deep-result')!;
  const deepThread = shadow.querySelector<HTMLElement>('.deep-thread')!;
  const deepInput = shadow.querySelector<HTMLInputElement>('.deep-input')!;
  const deepSend = shadow.querySelector<HTMLButtonElement>('.deep-send')!;
  let deepLevel: ExplainLevel = 'intermediate';
  let openText = '';
  let meta: SelectionCardMeta | null = null;
  let currentResult: LookupResult | null = null;
  /** 查询在途（已 open 未出结果）：此时收藏/朗读可用——收藏不该被查询成败绑架。 */
  let queryPending = false;
  /** 用户拖拽位移（模块级记忆）：拖到顺手的位置后，后续卡片沿用。 */
  let userOffset = { dx: 0, dy: 0 };
  /** 该站点的记忆位置（absolute）；null = 未记忆。 */
  let storedPosition: CardPosition | null = options?.initialPosition ?? null;
  /** 最近一次 open 的锚点（双击复位后重新贴回选区）。 */
  let anchorRect: SelectionCardAnchor['rect'] | null = null;
  let dragging = false;
  /** 锚点漂移追踪：滚动/缩放在小幅度内不关卡（超过阈值说明布局真的变了）。 */
  let lastScroll = { x: 0, y: 0 };
  let lastViewport = { w: 0, h: 0 };
  const DRIFT_CLOSE_PX = 120;
  let collected = false;
  let disposed = false;

  const closeButton = shadow.querySelector<HTMLButtonElement>('.close')!;
  closeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    close();
    options?.onManualClose?.();
  });

  /** 卡片可拖拽：命中控件/输入/选区时不启动拖拽；拖拽中实时改位并夹取视口。 */
  const dragStart = (event: PointerEvent): void => {
    if (card.hidden || disposed || event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target && target.closest('button, input, textarea, a, [role="textbox"]')) return;
    dragging = true;
    card.classList.add('dragging');
    const rect = card.getBoundingClientRect();
    const grabX = event.clientX - rect.left;
    const grabY = event.clientY - rect.top;
    try {
      card.setPointerCapture(event.pointerId);
    } catch {
      // jsdom 等无 pointer capture 环境：move/up 仍挂在卡片上，行为可退化但可用
    }
    const onMove = (move: PointerEvent): void => {
      if (!dragging) return;
      const width = card.offsetWidth || CARD_WIDTH;
      const height = card.offsetHeight || 200;
      const left = Math.max(CARD_MARGIN, Math.min(move.clientX - grabX, window.innerWidth - width - CARD_MARGIN));
      const top = Math.max(CARD_MARGIN, Math.min(move.clientY - grabY, window.innerHeight - height - CARD_MARGIN));
      card.style.left = left + 'px';
      card.style.top = top + 'px';
      card.style.bottom = 'auto';
      userOffset = { dx: left - rect.left, dy: top - rect.top };
    };
    const onUp = (): void => {
      if (dragging) {
        // 拖拽落点成为该站点的新默认位置
        const final = card.getBoundingClientRect();
        storedPosition = { left: Math.round(final.left), top: Math.round(final.top) };
        options?.onPositionChange?.(storedPosition);
      }
      dragging = false;
      card.classList.remove('dragging');
      card.removeEventListener('pointermove', onMove);
      card.removeEventListener('pointerup', onUp);
      card.removeEventListener('pointercancel', onUp);
    };
    card.addEventListener('pointermove', onMove);
    card.addEventListener('pointerup', onUp);
    card.addEventListener('pointercancel', onUp);
  };
  card.addEventListener('pointerdown', dragStart);
  card.addEventListener('dblclick', (event) => {
    // 双击卡片空白处复位到锚点默认位（拖歪了的回归路径）
    if (event.target !== card) return;
    if (!storedPosition && userOffset.dx === 0 && userOffset.dy === 0) return;
    storedPosition = null;
    userOffset = { dx: 0, dy: 0 };
    options?.onPositionReset?.();
    if (anchorRect) applyPlacement();
  });

  /** 放置：位置记忆优先（用户在本站拖过的位置直接复用），否则按选区侧边计算；两者都夹进视口。 */
  const applyPlacement = (): void => {
    const width = card.offsetWidth || CARD_WIDTH;
    const height = card.offsetHeight || 220;
    const computed = computeCardPlacement(anchorRect ?? { top: CARD_MARGIN, bottom: CARD_MARGIN, left: CARD_MARGIN, right: CARD_MARGIN }, window.innerWidth, window.innerHeight, height, width);
    const base = storedPosition ?? { left: computed.left + userOffset.dx, top: computed.top + userOffset.dy };
    const placed = clampToViewport(base, width, height, window.innerWidth, window.innerHeight, CARD_MARGIN);
    card.style.left = placed.left + 'px';
    card.style.top = placed.top + 'px';
    card.style.bottom = 'auto';
    lastScroll = { x: window.scrollX, y: window.scrollY };
    lastViewport = { w: window.innerWidth, h: window.innerHeight };
  };

  const isPointerInside = (x: number, y: number): boolean => {
    if (card.hidden || disposed) return false;
    const rect = card.getBoundingClientRect();
    const pad = 6;
    return x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad;
  };

  const close = (): void => {
    card.hidden = true;
    openText = '';
    currentResult = null;
    collected = false;
    saveButton.disabled = false;
    saveButton.classList.remove('saved');
    saveButton.textContent = '收藏';
    speakButton.disabled = true;
    speakButton.classList.remove('playing');
    speakButton.textContent = '朗读';
    // 卡片收起即止播：悬空播报是划词场景最刺耳的打扰
    options?.onStopSpeak?.();
    deepBtn.hidden = true;
    deepPanel.hidden = true;
    deepResult.textContent = '';
    deepThread.textContent = '';
    deepThread.hidden = true;
    deepInput.value = '';
    deepSend.disabled = true;
  };

  const askQuestion = (): void => {
    const question = deepInput.value.trim();
    if (!question || !options?.onAsk) return;
    options.onAsk(question);
  };
  deepBtn.addEventListener('click', () => {
    deepPanel.hidden = false;
    if (options?.onDeepRequest) options.onDeepRequest(deepLevel);
  });
  for (const button of deepLevelButtons) {
    button.addEventListener('click', () => {
      deepLevel = (button.dataset.level as ExplainLevel) ?? 'intermediate';
      for (const item of deepLevelButtons) item.classList.toggle('active', item === button);
      if (options?.onDeepRequest) options.onDeepRequest(deepLevel);
    });
  }
  deepSend.addEventListener('click', askQuestion);
  deepInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      askQuestion();
    }
  });
  deepInput.addEventListener('input', () => {
    deepSend.disabled = deepInput.value.trim().length === 0;
  });

  const onPointerDown = (event: PointerEvent): void => {
    if (card.hidden || disposed) return;
    const path = event.composedPath();
    if (path.includes(host)) return; // 卡片自身交互不关闭
    close();
    options?.onExternalPointerDown?.();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || card.hidden || disposed) return;
    event.stopPropagation();
    close();
  };
  /** 小幅滚动/缩放不关卡：锚点漂移（累计滚动 + 视口变化）超过 120px 才收起。 */
  const onDiscard = (): void => {
    if (card.hidden || disposed || dragging) return;
    const scrollDrift = Math.hypot(window.scrollX - lastScroll.x, window.scrollY - lastScroll.y);
    const viewportDrift = Math.hypot(window.innerWidth - lastViewport.w, window.innerHeight - lastViewport.h);
    if (scrollDrift + viewportDrift <= DRIFT_CLOSE_PX) {
      lastScroll = { x: window.scrollX, y: window.scrollY };
      lastViewport = { w: window.innerWidth, h: window.innerHeight };
      return;
    }
    close();
  };
  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onDiscard, true);
  window.addEventListener('resize', onDiscard, true);

  /** 当前渲染结果的可复制文本（复制按钮用）。 */
  let copyPayload = '';
  copyButton.addEventListener('click', () => {
    if (!copyPayload) return;
    void navigator.clipboard?.writeText(copyPayload).then(
      () => {
        copyButton.textContent = '已复制';
        window.setTimeout(() => { if (!disposed) copyButton.textContent = '复制'; }, 1200);
      },
      () => { copyButton.textContent = '复制失败'; },
    );
  });

  const syncSaveButton = (): void => {
    saveButton.disabled = collected || !(currentResult || queryPending);
    saveButton.classList.toggle('saved', collected);
    saveButton.textContent = collected ? '已收藏' : '收藏';
    const source = resolveSpeakSource(currentResult, meta);
    speakButton.disabled = !options?.onSpeak || source.text.length === 0;
  };
  speakButton.addEventListener('click', () => {
    const source = resolveSpeakSource(currentResult, meta);
    if (!options?.onSpeak || !source.text) return;
    if (speakButton.classList.contains('playing')) {
      options.onStopSpeak?.();
      speakButton.classList.remove('playing');
      speakButton.textContent = '朗读';
      return;
    }
    options.onSpeak(source.text, source.kind);
    speakButton.classList.add('playing');
    speakButton.textContent = '停止';
  });
  saveButton.addEventListener('click', () => {
    if (!options?.onSave || (!currentResult && !queryPending) || collected || disposed) return;
    saveButton.disabled = true;
    saveButton.textContent = '收藏中…';
    void options.onSave(currentResult, meta).then((saved) => {
      if (disposed) return;
      if (saved) {
        collected = true;
      } else {
        // 失败回退为可重试；短暂提示由文案变化承载
        saveButton.textContent = '收藏失败';
        window.setTimeout(() => {
          if (!disposed && !collected) syncSaveButton();
        }, 1400);
        return;
      }
      syncSaveButton();
    });
  });

  return {
    open(loadingText, anchor, cardMeta) {
      if (disposed) return;
      openText = loadingText;
      meta = cardMeta ?? null;
      currentResult = null;
      queryPending = true;
      collected = false;
      syncSaveButton();
      copyPayload = '';
      body.innerHTML = `<div class="status">${esc(loadingText)}</div>`;
      card.hidden = false;
      anchorRect = anchor.rect;
      applyPlacement();
    },
    render(result, state) {
      if (disposed || card.hidden) return;
      currentResult = result;
      queryPending = false;
      // 收藏态粘性：用户已表达的意图不因后续渲染被取消（重开卡片才复位）
      if (state?.collected === true) collected = true;
      syncSaveButton();
      deepBtn.hidden = !options?.onDeepRequest;
      const parts: string[] = ['<div class="head">'];
      parts.push(`<span class="term">${esc(result.term)}</span>`);
      if (result.phonetic) parts.push(`<span class="phonetic">${esc(result.phonetic)}</span>`);
      if (result.partOfSpeech) parts.push(`<span class="pos">${esc(result.partOfSpeech)}</span>`);
      parts.push('</div>');
      if (result.translation) parts.push(`<div class="translation">${esc(result.translation)}</div>`);
      if (result.definition) parts.push(`<div class="definition">${esc(result.definition)}</div>`);
      if (result.example) parts.push(`<div class="example">${esc(result.example)}</div>`);
      body.innerHTML = parts.join('');
      copyPayload = [result.term, result.phonetic, result.partOfSpeech, result.translation, result.definition, result.example]
        .filter(Boolean).join('\n');
    },
    showError(message) {
      if (disposed || card.hidden) return;
      queryPending = false;
      syncSaveButton();
      body.innerHTML = `<div class="status error">${esc(message)}</div>`;
      copyPayload = '';
    },
    openNotice(message, anchor, cardMeta) {
      if (disposed) return;
      this.open('', anchor, cardMeta);
      // 提示态没有可收藏的查询（超长选段等）：显式禁用，避免收藏到陈旧 currentQuery
      queryPending = false;
      syncSaveButton();
      saveButton.disabled = true;
      speakButton.disabled = true;
      body.textContent = '';
      const line = document.createElement('div');
      line.className = 'status';
      line.textContent = message;
      body.append(line);
    },
    showDeepLoading(label) {
      if (disposed || card.hidden) return;
      deepPanel.hidden = false;
      deepResult.textContent = label;
    },
    renderDeep(result) {
      if (disposed || card.hidden) return;
      deepResult.textContent = '';
      const labels = [['总述', result.answer], ['语法', result.grammar], ['用法辨析', result.usage], ['易错点', result.pitfalls], ['例句', result.example]] as const;
      for (const [label, value] of labels) {
        if (!value) continue;
        const box = document.createElement('div');
        box.className = 'deep-block';
        const caption = document.createElement('div');
        caption.className = 'label';
        caption.textContent = label;
        const text = document.createElement('div');
        text.className = 'value';
        text.textContent = value;
        box.append(caption, text);
        deepResult.append(box);
      }
      deepInput.disabled = false;
      deepSend.disabled = deepInput.value.trim().length === 0;
    },
    showDeepError(message) {
      if (disposed || card.hidden) return;
      deepResult.textContent = '';
      const line = document.createElement('div');
      line.className = 'status error';
      line.textContent = message;
      deepResult.append(line);
      deepInput.disabled = false;
    },
    appendExchange(question, answer) {
      if (disposed || card.hidden) return;
      deepThread.hidden = false;
      const q = document.createElement('div');
      q.className = 'deep-q';
      q.textContent = 'Q: ' + question;
      const a = document.createElement('div');
      a.className = 'deep-a';
      a.textContent = 'A: ' + answer;
      deepThread.append(q, a);
      deepThread.scrollTop = deepThread.scrollHeight;
      deepInput.value = '';
      deepInput.disabled = false;
      deepSend.disabled = true;
    },
    setAskEnabled(enabled) {
      deepInput.disabled = !enabled;
      deepSend.disabled = !enabled || deepInput.value.trim().length === 0;
    },
    isPointerInside,
    close,
    isOpen: () => !card.hidden,
    destroy() {
      disposed = true;
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onDiscard, true);
      window.removeEventListener('resize', onDiscard, true);
      host.remove();
    },
  };
};
