/**
 * 颜色可读性：可读性 = 前景色与背景的对比度，而非颜色本身。
 * 网页为暗色（深背景 + 白/浅文字）时，插件的深色译文不可读——
 * 因此按背景亮度自适应译文颜色：暗背景自动提亮用户配置色，
 * 亮背景保持用户配置色。所有计算基于 WCAG 相对亮度与对比度。
 */

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** 背景亮度阈值：低于视为暗背景（深色网页 / 夜间模式）。 */
export const DARK_BG_LUMINANCE = 0.35;
/** 强制达到的可读对比度（WCAG AA 正文级）。 */
export const TARGET_CONTRAST = 4.5;

const hexToRgb = (hex: string): RgbColor | null => {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  };
};

const rgbToHex = (rgb: RgbColor): string =>
  `#${[rgb.r, rgb.g, rgb.b].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;

const rgbToHslL = (rgb: RgbColor): number => {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
};

/** 由 RGB 直接按亮度权重换算（近似 HSL 亮度的视觉效果足够用于提亮）。 */
const lightenRgb = (rgb: RgbColor, targetL: number): RgbColor => {
  const currentL = rgbToHslL(rgb);
  if (currentL >= targetL) return rgb;
  // 向白色方向插值：权重由当前亮度到目标亮度决定
  const t = (targetL - currentL) / (1 - currentL);
  return {
    r: rgb.r + (255 - rgb.r) * t,
    g: rgb.g + (255 - rgb.g) * t,
    b: rgb.b + (255 - rgb.b) * t,
  };
};

/** 向黑色方向插值（浅背景上提高对比度的正确方向：提亮只会更糊）。 */
const darkenRgb = (rgb: RgbColor, targetL: number): RgbColor => {
  const currentL = rgbToHslL(rgb);
  if (currentL <= targetL) return rgb;
  const t = (currentL - targetL) / currentL;
  return { r: rgb.r * (1 - t), g: rgb.g * (1 - t), b: rgb.b * (1 - t) };
};

/** WCAG 相对亮度（0 黑 ~ 1 白）。 */
export const relativeLuminance = (rgb: RgbColor): number => {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
};

/** WCAG 对比度（1 最低 ~ 21 最高）。 */
export const contrastRatio = (foreground: RgbColor, background: RgbColor): number => {
  const l1 = relativeLuminance(foreground);
  const l2 = relativeLuminance(background);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
};

/**
 * 对比度（基于两个相对亮度值）。
 */
export const contrastFromLuminance = (lum1: number, lum2: number): number => {
  const lighter = Math.max(lum1, lum2);
  const darker = Math.min(lum1, lum2);
  return (lighter + 0.05) / (darker + 0.05);
};

/**
 * 解析可读译文颜色：目标是对比度达标（WCAG AA 正文 4.5:1），而非固定阈值。
 *   - 无背景信息 → 原样返回用户配置色；
 *   - 已达标 → 用户配置色原样（绝大多数浅底页面走这条路径，视觉零变化）；
 *   - 未达标 → 朝「远离背景亮度」的一侧推进：暗背景提亮、浅/中浅背景压暗。
 *     中浅灰背景（亮度 0.35–0.6）上深色译文会掉到 4.5:1 以下，提亮只会更糊，
 *     必须压暗——这是旧的「暗背景才处理」阈值模型漏掉的区间。
 */
export const resolveReadableColor = (userColor: string, bgLuminance: number | null | undefined): string => {
  const user = hexToRgb(userColor);
  if (!user || bgLuminance === null || bgLuminance === undefined) return userColor;
  if (contrastFromLuminance(relativeLuminance(user), bgLuminance) >= TARGET_CONTRAST) return userColor;

  const backgroundIsLight = bgLuminance >= DARK_BG_LUMINANCE;
  let adjusted = user;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    adjusted = backgroundIsLight
      ? darkenRgb(user, Math.max(0, 0.5 - attempt * 0.06))
      : lightenRgb(user, Math.min(1, 0.72 + attempt * 0.04));
    if (contrastFromLuminance(relativeLuminance(adjusted), bgLuminance) >= TARGET_CONTRAST) break;
  }
  return rgbToHex(adjusted);
};