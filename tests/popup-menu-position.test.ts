import { describe, expect, it } from 'vitest';
import { computeMenuPlacement } from '../chrome-plugin/src/utils/popupMenuPosition';

describe('computeMenuPlacement', () => {
  it('空间充足时向下展开，maxHeight 不被压缩', () => {
    const p = computeMenuPlacement(147, 183, 620);
    expect(p.placement).toBe('below');
    expect(p.top).toBe(191); // 183 + 8
    expect(p.maxHeight).toBe(216); // min(216, 620-183-8=429)
  });

  it('弹窗高度约 400、触发控件偏下时：maxHeight 钳到可用空间，绝不溢出视口', () => {
    // 真实弹窗场景：视口 400，翻译服务按钮 bottom≈183
    const p = computeMenuPlacement(147, 183, 400);
    expect(p.placement).toBe('below');
    expect(p.top).toBe(191);
    // 可用下方空间 = 400-183-8 = 209 < 216 → 钳到 209
    expect(p.maxHeight).toBe(209);
    // 菜单底边 = top + maxHeight = 191 + 209 = 400 = 视口高 → 零溢出
    expect(p.top! + p.maxHeight).toBe(400);
  });

  it('下方空间不足且上方更宽时向上展开', () => {
    // 触发控件贴近视口底部：top=350, bottom=386, viewport=400
    const p = computeMenuPlacement(350, 386, 400);
    expect(p.placement).toBe('above');
    expect(p.bottom).toBe(58); // 400 - 350 + 8
    expect(p.maxHeight).toBe(216); // 上方可用 342 > 216
    // 菜单顶边 = viewport - bottom - maxHeight = 400 - 58 - 216 = 126 ≥ 0
    expect(400 - p.bottom! - p.maxHeight).toBeGreaterThanOrEqual(0);
  });

  it('下方略小于上方但仍过 160 地板时优先向下（短视口不频繁上翻）', () => {
    // below=170, above=190 → below < above 但 below ≥ 160 → 仍向下
    const p = computeMenuPlacement(198, 222, 400);
    expect(p.placement).toBe('below');
    expect(p.maxHeight).toBe(170); // 钳到可用下方 170
  });

  it('极端矮视口保底最小可读高度（minMaxHeight）', () => {
    const p = computeMenuPlacement(10, 40, 60, { minMaxHeight: 100 });
    expect(p.maxHeight).toBe(100); // 可用仅 12，但保底 100
  });
});
