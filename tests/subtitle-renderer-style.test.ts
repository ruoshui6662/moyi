import { describe, expect, it } from 'vitest';

import {
  buildShadowCss,
  buildStrokeWidthPx,
  ORIGINAL_LINE_RATIO,
} from '../chrome-plugin/src/utils/subtitles/renderer';

describe('字幕样式纯函数', () => {
  it('阴影强度 0/非法值 = 无阴影；强度越高暗影越实', () => {
    expect(buildShadowCss(0)).toBe('none');
    expect(buildShadowCss(Number.NaN)).toBe('none');
    expect(buildShadowCss(1)).toContain('rgba(0, 0, 0, 0.90)');
    expect(buildShadowCss(1)).toContain('10.0px');
    expect(buildShadowCss(0.5)).not.toEqual(buildShadowCss(1));
  });

  it('描边宽度随字号等比（约 4.5%），下限 1px', () => {
    // 22 × 0.045 = 0.99，被下限钳到 1
    expect(buildStrokeWidthPx(22)).toBe(1);
    expect(buildStrokeWidthPx(14)).toBe(1);
    expect(buildStrokeWidthPx(36)).toBeCloseTo(1.62, 2);
    expect(buildStrokeWidthPx(Number.NaN)).toBe(1);
  });

  it('原文行缩放比合同：预览 CSS 与渲染层须同步引用同一比例', () => {
    expect(ORIGINAL_LINE_RATIO).toBe(0.85);
  });
});
