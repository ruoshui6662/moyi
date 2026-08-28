/**
 * 弹窗浮层菜单的定位计算（纯函数，无 DOM 依赖，便于单测）。
 *
 * 弹窗是固定尺寸视口，position:fixed 元素不会撑大窗口、会被视口裁剪。
 * 故按触发控件上/下可用空间择优开向，并把 maxHeight 钳到可用空间内
 * （超出靠菜单内部滚动，绝不溢出视口）。
 */

export interface MenuPlacement {
  /** 向下展开时距视口顶的距离（px）；向上展开时为 undefined。 */
  top?: number;
  /** 向上展开时距视口底的距离（px）；向下展开时为 undefined。 */
  bottom?: number;
  maxHeight: number;
  placement: 'below' | 'above';
}

export interface MenuPlacementOptions {
  margin?: number;
  maxHeight?: number;
  /** maxHeight 的下限：极端矮视口时仍保证最小可读高度。 */
  minMaxHeight?: number;
  /** 下方空间不小于该值时优先向下（避免短视口里频繁向上翻）。 */
  belowPreferenceFloor?: number;
}

export const computeMenuPlacement = (
  triggerTop: number,
  triggerBottom: number,
  viewportH: number,
  opts: MenuPlacementOptions = {},
): MenuPlacement => {
  const margin = opts.margin ?? 8;
  const maxHeight = opts.maxHeight ?? 216;
  const minMaxHeight = opts.minMaxHeight ?? 120;
  const belowFloor = opts.belowPreferenceFloor ?? 160;
  const below = viewportH - triggerBottom - margin;
  const above = triggerTop - margin;
  const preferBelow = below >= above || below >= belowFloor;
  const available = preferBelow ? below : above;
  const clampedMax = Math.max(minMaxHeight, Math.min(maxHeight, available));
  if (preferBelow) {
    return { top: triggerBottom + margin, maxHeight: clampedMax, placement: 'below' };
  }
  return { bottom: viewportH - triggerTop + margin, maxHeight: clampedMax, placement: 'above' };
};
