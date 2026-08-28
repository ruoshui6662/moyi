import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLOAT_HOST_ID,
  getFloatFab,
  mountFloatingButton,
  syncFloatingButtonState,
} from '../chrome-plugin/src/entrypoints/content/floatingButton';

/** 便捷取按钮（closed shadow 下经模块内登记表读取）。 */
const fabOf = (): HTMLButtonElement => {
  const host = document.getElementById(FLOAT_HOST_ID);
  expect(host).not.toBeNull();
  const fab = getFloatFab(host);
  expect(fab).not.toBeNull();
  return fab!;
};

describe('floating button', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '';
    document.body.innerHTML = '';
  });

  const mount = (translated = false) => {
    let state = translated;
    const onToggle = vi.fn();
    const unmount = mountFloatingButton({
      isTranslated: () => state,
      onToggle: () => {
        state = !state;
        onToggle();
      },
    });
    return { onToggle, unmount, setTranslated: (v: boolean) => { state = v; } };
  };

  it('mounts a single host with the circular brand logo by default', () => {
    mount();
    const host = document.getElementById(FLOAT_HOST_ID);
    expect(host).not.toBeNull();
    expect(document.querySelectorAll(`#${FLOAT_HOST_ID}`)).toHaveLength(1);

    const fab = fabOf();
    expect(fab.getAttribute('aria-label')).toBe('翻译当前页');
    // 品牌位是圆形 logo 位图（内联 data URI），而非文字字形
    const logo = fab.querySelector<HTMLImageElement>('img.logo');
    expect(logo?.getAttribute('src')?.startsWith('data:image/png')).toBe(true);
    // 默认（未翻译）无绿色对号徽章
    expect(fab.classList.contains('translated')).toBe(false);

    // closed shadow：页面脚本无法经 host.shadowRoot 触达按钮
    expect(host?.shadowRoot).toBeNull();
  });

  it('is invisible until the stored position resolves, then fades in', async () => {
    const mounted = mount();
    const fab = fabOf();

    // 刚挂载：按默认位渲染但不可见（未 .ready），避免左上角闪现
    expect(fab.classList.contains('ready')).toBe(false);

    // 存储读取完成（无存储也统一走 ready 分支）→ 淡入
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fab.classList.contains('ready')).toBe(true);
    mounted.unmount();
  });

  it('reamounts on repeated mounts without duplicates and with live handlers', () => {
    const first = mount();
    first.unmount();
    const second = mount();
    expect(document.querySelectorAll(`#${FLOAT_HOST_ID}`)).toHaveLength(1);

    // 重新注入后（模拟插件重载）新按钮的事件必须可用
    const fab = fabOf();
    fab.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    fab.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }));
    expect(second.onToggle).toHaveBeenCalledTimes(1);
  });

  it('reclaims a stale host left by a reloaded extension instead of skipping', () => {
    // 复现「插件重载后旧 host 残留」：手动往页面放一个无事件的僵尸 host
    const stale = document.createElement('div');
    stale.id = FLOAT_HOST_ID;
    const staleShadow = stale.attachShadow({ mode: 'open' });
    staleShadow.innerHTML = '<button class="fab" type="button">译</button>';
    document.documentElement.appendChild(stale);

    const second = mount();
    expect(document.querySelectorAll(`#${FLOAT_HOST_ID}`)).toHaveLength(1);
    const fab = fabOf();
    fab.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    fab.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }));
    expect(second.onToggle).toHaveBeenCalledTimes(1);
  });

  it('syncs the button to translated state when译文存在', () => {
    const { setTranslated } = mount();
    syncFloatingButtonState({ isTranslated: () => true as boolean, onToggle: vi.fn() });
    const fab = fabOf();
    expect(fab.classList.contains('translated')).toBe(true);
    expect(fab.getAttribute('aria-label')).toBe('移除译文');
    // 翻译态语义提示同步到悬停 title，且绿色对号徽章就位（显隐由 .translated 驱动）
    expect(fab.getAttribute('title')).toBe('移除译文');
    expect(fab.querySelector('.badge svg')).not.toBeNull();
    setTranslated(false);
  });

  it('unmount removes the host', () => {
    const { unmount } = mount();
    expect(document.getElementById(FLOAT_HOST_ID)).not.toBeNull();
    unmount();
    expect(document.getElementById(FLOAT_HOST_ID)).toBeNull();
  });

  it('clicking the button triggers the toggle callback', () => {
    const { onToggle } = mount();
    const fab = fabOf();

    fab.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    fab.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('docks to the left edge when dragged there and released', () => {
    const { onToggle } = mount();
    const fab = fabOf();

    // 向左拖拽越过阈值后释放（jsdom 中 rect.left 恒为 0，满足左边缘吸附）
    fab.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 100 }));
    fab.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 60, clientY: 100 }));
    fab.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }));

    expect(fab.classList.contains('docked-left')).toBe(true);
    expect(fab.classList.contains('docked-right')).toBe(false);
    expect(fab.style.left).toBe('0px');
    expect(fab.style.right).toBe('auto');
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('docks to the right edge as a visible capsule inside the viewport', () => {
    const { onToggle } = mount();
    const fab = fabOf();

    // 向右拖拽越过阈值后释放（jsdom 视口 1024 宽，拖动终点 lastDragLeft 逼近右缘命中右吸附）
    fab.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 100 }));
    fab.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 1100, clientY: 100 }));
    fab.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }));

    expect(fab.classList.contains('docked-right')).toBe(true);
    expect(fab.style.right).toBe('0px');
    expect(fab.style.left).toBe('auto');
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('clicking the docked handle still triggers the toggle', () => {
    const { onToggle } = mount();
    const fab = fabOf();

    // 先吸附到左边缘
    fab.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 100 }));
    fab.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 60, clientY: 100 }));
    fab.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }));
    expect(fab.classList.contains('docked-left')).toBe(true);

    // 吸附态下点击（无位移）触发动作
    fab.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 6, clientY: 100 }));
    fab.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('pressing the docked handle releases the dock and restores full size', () => {
    const { onToggle } = mount();
    const fab = fabOf();

    fab.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 100 }));
    fab.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 60, clientY: 100 }));
    fab.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }));
    expect(fab.classList.contains('docked-left')).toBe(true);

    // 再次按下（拖动开始）→ 解除吸附
    fab.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 6, clientY: 100 }));
    expect(fab.classList.contains('docked-left')).toBe(false);
    expect(fab.style.transform === 'none' || fab.style.transform === '').toBe(true);

    // 解除后无位移释放 → 视为点击触发动作
    fab.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});