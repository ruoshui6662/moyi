/**
 * 可视化拾取器（插件独有入口，红线 3）：站点规则编辑器的「点选元素生成选择器」。
 *
 * 交互：进入拾取模式 → 指针移动时高亮目标（描边 + 简报气泡）→ 单击选定 →
 * 生成选择器回传后台（写入瞬时键，设置页监听回填）→ 退出模式。
 *
 * 约束：
 * - 纯视觉层 + 一行消息，不碰任何配置存储——设置页负责决定是否采用；
 * - 扩展自有浮层（本站的卡片/悬浮球/字幕）不参与拾取；
 * - Esc 随时退出；模式期间拦截点击与 hover 默认行为（capture + preventDefault）。
 */

import { buildElementSelector } from '../utils/selectorGen';

const HOST_ID = 'moyi-element-picker';

const OVERLAY_CSS = `
  :host { all: initial; }
  .veil { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; font-family: system-ui, sans-serif; }
  .box { position: fixed; border: 2px solid #0a84ff; background: rgba(10,132,255,.10); border-radius: 3px; display: none; }
  .tag {
    position: fixed; display: none; max-width: 420px;
    background: rgba(20,20,24,.92); color: #fff; font-size: 12px; line-height: 1.5;
    padding: 3px 8px; border-radius: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .hint {
    position: fixed; left: 50%; top: 16px; transform: translateX(-50%);
    background: rgba(20,20,24,.9); color: #fff; font-size: 12px; padding: 6px 12px; border-radius: 999px;
  }
`;

interface PickedResult {
  selector: string;
  unique: boolean;
  label: string;
  /** 供设置页判断是否同站规则的 host 与预览。 */
  url: string;
  title: string;
  textSample: string;
}

let cleanup: (() => void) | null = null;

const isOwnOverlay = (element: Element): boolean =>
  Boolean(element.closest('#moyi-float-control, [data-personal-translator-owned]')) || element.id.startsWith('moyi-');

const start = (): void => {
  if (document.getElementById(HOST_ID)) return;
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all: initial; position: static;';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>${OVERLAY_CSS}</style>
    <div class="veil">
      <div class="box"></div>
      <div class="tag"></div>
      <div class="hint">点击要选取的元素 · Esc 退出</div>
    </div>`;
  document.documentElement.appendChild(host);
  const box = shadow.querySelector<HTMLElement>('.box')!;
  const tag = shadow.querySelector<HTMLElement>('.tag')!;

  const onMove = (event: PointerEvent): void => {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (!target || isOwnOverlay(target)) {
      box.style.display = 'none';
      tag.style.display = 'none';
      return;
    }
    const rect = target.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = rect.left + 'px';
    box.style.top = rect.top + 'px';
    box.style.width = Math.max(0, rect.width) + 'px';
    box.style.height = Math.max(0, rect.height) + 'px';
    tag.style.display = 'block';
    tag.textContent = target.tagName.toLowerCase() + (target.id ? '#' + target.id : '') + (target.classList.length ? '.' + Array.from(target.classList).slice(0, 2).join('.') : '');
    tag.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - 430)) + 'px';
    tag.style.top = Math.max(4, rect.top - 26) + 'px';
  };

  const onClick = (event: PointerEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (!target || isOwnOverlay(target)) return;
    const result = buildElementSelector(target);
    const payload: PickedResult = {
      selector: result.selector,
      unique: result.unique,
      label: result.label,
      url: location.href,
      title: document.title,
      textSample: (target.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    };
    void chrome.runtime.sendMessage({ type: 'element-picked', ...payload }).catch(() => undefined);
    stop();
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      stop();
    }
  };

  const stop = (): void => {
    cleanup?.();
  };
  cleanup = () => {
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    host.remove();
    cleanup = null;
  };

  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
};

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_idle',
  main() {
    chrome.runtime.onMessage.addListener((message: unknown) => {
      if ((message as { type?: string } | null)?.type === 'element-picker-start') start();
      return false;
    });
    // 控制台入口（与试运行命令同款）：
    // document.dispatchEvent(new CustomEvent('moyi:start-element-picker'))
    document.addEventListener('moyi:start-element-picker', start);
  },
});
