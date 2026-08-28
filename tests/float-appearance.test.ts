/**
 * 悬浮按钮外观（大小 / 透明度）测试：
 *   - config 清洗函数的边界收敛；
 *   - 挂载时初始外观写入（CSS 变量）；
 *   - 越界值防御性钳制；
 *   - 运行时热更新（applyFloatAppearance）与未挂载时的静默跳过。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLOAT_OPACITY_DEFAULT,
  FLOAT_OPACITY_MAX,
  FLOAT_OPACITY_MIN,
  FLOAT_SIZE_DEFAULT,
  FLOAT_SIZE_MAX,
  FLOAT_SIZE_MIN,
  sanitizeFloatOpacity,
  sanitizeFloatSize,
} from '../chrome-plugin/src/utils/config';
import {
  applyFloatAppearance,
  FLOAT_HOST_ID,
  getFloatFab,
  mountFloatingButton,
} from '../chrome-plugin/src/entrypoints/content/floatingButton';

const fabOf = (): HTMLButtonElement => {
  const host = document.getElementById(FLOAT_HOST_ID);
  expect(host).not.toBeNull();
  const fab = getFloatFab(host);
  expect(fab).not.toBeNull();
  return fab!;
};

describe('float appearance config sanitize', () => {
  it('floatSize 钳制到 [26, 48] 并取整，非法值回默认', () => {
    expect(sanitizeFloatSize(32)).toBe(32);
    expect(sanitizeFloatSize(FLOAT_SIZE_MIN - 5)).toBe(FLOAT_SIZE_MIN);
    expect(sanitizeFloatSize(FLOAT_SIZE_MAX + 99)).toBe(FLOAT_SIZE_MAX);
    expect(sanitizeFloatSize(37.6)).toBe(38);
    expect(sanitizeFloatSize('abc' as unknown as number)).toBe(FLOAT_SIZE_DEFAULT);
    expect(sanitizeFloatSize(undefined)).toBe(FLOAT_SIZE_DEFAULT);
  });

  it('floatOpacity 钳制到 [0.15, 1]，非法值回默认', () => {
    expect(sanitizeFloatOpacity(0.5)).toBe(0.5);
    expect(sanitizeFloatOpacity(FLOAT_OPACITY_MIN - 0.1)).toBe(FLOAT_OPACITY_MIN);
    expect(sanitizeFloatOpacity(FLOAT_OPACITY_MAX + 3)).toBe(FLOAT_OPACITY_MAX);
    expect(sanitizeFloatOpacity(Number.NaN)).toBe(FLOAT_OPACITY_DEFAULT);
    expect(sanitizeFloatOpacity(null as unknown as number)).toBe(FLOAT_OPACITY_DEFAULT);
  });

  it('默认值合同：尺寸小于旧版 36，透明度低于 1（更不遮挡阅读）', () => {
    expect(FLOAT_SIZE_DEFAULT).toBeLessThan(36);
    expect(FLOAT_OPACITY_DEFAULT).toBeLessThan(1);
    expect(sanitizeFloatSize(FLOAT_SIZE_DEFAULT)).toBe(FLOAT_SIZE_DEFAULT);
    expect(sanitizeFloatOpacity(FLOAT_OPACITY_DEFAULT)).toBe(FLOAT_OPACITY_DEFAULT);
  });
});

describe('floating button appearance', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '';
    document.body.innerHTML = '';
  });

  const mount = (appearance?: { size: number; opacity: number }) => {
    const onToggle = vi.fn();
    const unmount = mountFloatingButton({
      isTranslated: () => false,
      onToggle,
      ...(appearance ? { appearance } : {}),
    });
    return { onToggle, unmount };
  };

  it('挂载时把初始外观写入 CSS 变量', () => {
    mount({ size: 40, opacity: 0.5 });
    const fab = fabOf();
    expect(fab.style.getPropertyValue('--moyi-fab-size')).toBe('40px');
    expect(fab.style.getPropertyValue('--moyi-fab-opacity')).toBe('0.5');
  });

  it('缺省外观使用默认值', () => {
    mount();
    const fab = fabOf();
    expect(fab.style.getPropertyValue('--moyi-fab-size')).toBe(`${FLOAT_SIZE_DEFAULT}px`);
    expect(fab.style.getPropertyValue('--moyi-fab-opacity')).toBe(String(FLOAT_OPACITY_DEFAULT));
  });

  it('越界外观被防御性钳制', () => {
    mount({ size: 999, opacity: -2 });
    const fab = fabOf();
    expect(fab.style.getPropertyValue('--moyi-fab-size')).toBe(`${FLOAT_SIZE_MAX}px`);
    expect(Number(fab.style.getPropertyValue('--moyi-fab-opacity'))).toBeGreaterThanOrEqual(FLOAT_OPACITY_MIN);
  });

  it('applyFloatAppearance 热更新已挂载按钮', () => {
    mount();
    const fab = fabOf();
    applyFloatAppearance({ size: 28, opacity: 0.3 });
    expect(fab.style.getPropertyValue('--moyi-fab-size')).toBe('28px');
    expect(fab.style.getPropertyValue('--moyi-fab-opacity')).toBe('0.3');
  });

  it('未挂载时 applyFloatAppearance 静默跳过', () => {
    expect(() => applyFloatAppearance({ size: 30 })).not.toThrow();
  });
});
