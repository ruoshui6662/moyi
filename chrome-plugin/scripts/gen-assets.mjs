/**
 * 品牌资产生成：从 log/ 下设计稿导出扩展与悬浮球所需的位图资产。
 *
 *   log/墨译-圆角矩形.png ─→ public/icon/{16,32,48,128}.png        （主 logo：工具栏、popup、设置页）
 *   log/墨译-圆形.png     ─→ src/entrypoints/content/floatLogo.ts （网页悬浮球用 72px 圆形图，内联 data URI）
 *
 * public/ 放项目根目录：WXT 的 publicDir 相对 root 解析（不随 srcDir），构建时整体拷贝到产物根。
 * 用法：npm i --no-save sharp && node scripts/gen-assets.mjs
 * 为什么悬浮球走 data URI 而不是扩展静态资源：
 *   悬浮球代码被扩展 content script 与油猴脚本共用；油猴环境拿不到
 *   chrome-extension:// 资源，声明 web_accessible_resources 又会把资产
 *   暴露给所有页面。内联 72px PNG（≈10KB）是两个宿主唯一通行的形式。
 *
 * 用法：npm i --no-save sharp && node scripts/gen-assets.mjs
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { default: sharp } = await import('sharp');

const ROUNDED_SQUARE_SRC = resolve(root, 'log', '墨译-圆角矩形.png');
const CIRCLE_SRC = resolve(root, 'log', '墨译-圆形.png');
const ICON_SIZES = [16, 32, 48, 128];
/** 悬浮球按钮 CSS 尺寸 36px，出 2x 图保证高分屏清晰。 */
const FLOAT_LOGO_PX = 72;

// ── 主 logo：圆角矩形 → 标准扩展图标（WXT publicDir：根目录 public/ → 产物根）──
await mkdir(resolve(root, 'public', 'icon'), { recursive: true });
for (const size of ICON_SIZES) {
  await sharp(ROUNDED_SQUARE_SRC)
    .resize(size, size, { kernel: 'lanczos3' })
    .png()
    .toFile(resolve(root, 'public', 'icon', `${size}.png`));
  console.log(`icon/${size}.png ✓`);
}

// ── 悬浮球：圆形 → 烘焙圆形 alpha 蒙版（原图无 alpha 通道），内联进 TS 模块 ──
const circleSvg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${FLOAT_LOGO_PX}" height="${FLOAT_LOGO_PX}">` +
    `<circle cx="${FLOAT_LOGO_PX / 2}" cy="${FLOAT_LOGO_PX / 2}" r="${FLOAT_LOGO_PX / 2 - 0.4}" fill="#fff"/>` +
    '</svg>',
);
const circlePng = await sharp(CIRCLE_SRC)
  .resize(FLOAT_LOGO_PX, FLOAT_LOGO_PX, { kernel: 'lanczos3' })
  .composite([{ input: circleSvg, blend: 'dest-in' }])
  .png()
  .toBuffer();

const floatLogoModule =
  `/**
 * 悬浮球品牌图（圆形 logo）。由 scripts/gen-assets.mjs 生成，勿手改。
 * 来源 log/墨译-圆形.png：${FLOAT_LOGO_PX}px（36px 按钮 @2x）、圆形 alpha 蒙版、data URI 内联——
 * 扩展 content script 与油猴脚本共用本模块，油猴环境访问不了 chrome-extension:// 资源。
 */
export const FLOAT_LOGO_DATA_URI =
  'data:image/png;base64,${circlePng.toString('base64')}';
`;
await writeFile(resolve(root, 'src', 'entrypoints', 'content', 'floatLogo.ts'), floatLogoModule);
console.log(`content/floatLogo.ts ✓ (${Math.round(circlePng.length / 1024)}KB)`);
