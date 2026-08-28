import { describe, expect, it } from 'vitest';

import {
  clampStepFontSize,
  computePanelBottomOffset,
  CONTROLS_CHROME_DEFAULT_HEIGHT,
  isDismissTarget,
} from '../chrome-plugin/src/utils/subtitles/renderer';

describe('播放器控件纯函数', () => {
  it('面板底部偏移：控制条可见时抬到其上方 18px，隐藏时贴底 22px', () => {
    expect(computePanelBottomOffset(true, 60)).toBe(78);
    expect(computePanelBottomOffset(false, 60)).toBe(22);
    // 高度异常按 0 处理，不产生负偏移
    expect(computePanelBottomOffset(true, 0)).toBe(18);
    expect(computePanelBottomOffset(true, Number.NaN)).toBe(18);
  });

  it('控制层兜底高度：测不到 DOM 时宁可多让位也不盖住原生控件', () => {
    expect(CONTROLS_CHROME_DEFAULT_HEIGHT).toBeGreaterThanOrEqual(56);
  });

  it('字号步进钳制到 [14,36]，非法基准回中值', () => {
    expect(clampStepFontSize(22, 2)).toBe(24);
    expect(clampStepFontSize(35, 2)).toBe(36);
    expect(clampStepFontSize(15, -2)).toBe(14);
    expect(clampStepFontSize(Number.NaN, 4)).toBe(29);
    expect(clampStepFontSize(21.6, 0)).toBe(22);
  });

  it('外部点击判定：事件路径含面板或徽标时不视为外部', () => {
    const panel = { tag: 'panel' } as unknown as Element;
    const chip = { tag: 'chip' } as unknown as Element;
    expect(isDismissTarget([panel], panel, chip)).toBe(false);
    expect(isDismissTarget([chip], panel, chip)).toBe(false);
    expect(isDismissTarget([], panel, chip)).toBe(true);
  });
});
