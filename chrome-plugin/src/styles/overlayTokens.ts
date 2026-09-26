/**
 * 叠加型 UI 的 token 镜像（悬浮钮 / 字幕覆层 / 播放器面板）。
 *
 * 为什么单独一份：这三个 UI 用 Shadow DOM 承载样式，需要把 CSS 作为字符串注入，
 * 无法引用 `styles/tokens.css` 的 <link>；而它们又是扩展与油猴共用模块（油猴端由
 * esbuild 打包，不能引入 Vite 专有的 `?inline` CSS 语法），因此这里以纯 TS 字符串
 * 提供同一组取值。
 *
 * 契约：取值必须与 `src/styles/tokens.css` 中的 `--overlay-*` 组保持一致，
 * 由 `tests/token-parity.test.ts` 守护；改一处必须同步另一处。
 */

/** 叠加型 UI 固定深色 token（浅深模式通用）。 */
export const OVERLAY_TOKENS_CSS = `
  --overlay-surface: rgba(17, 17, 20, 0.94);
  --overlay-surface-solid: #17171a;
  --overlay-border: rgba(255, 255, 255, 0.14);
  --overlay-label: #f2f2f4;
  --overlay-label-2: #b9b9c0;
  --overlay-success: #12a35f;
  --overlay-danger: #ff6b5e;
  --overlay-radius-sm: 8px;
  --overlay-radius-md: 12px;
  --duration-fast: 120ms;
  --duration-base: 200ms;
  --ease-standard: cubic-bezier(0.4, 0, 0.2, 1);
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
`;

/** 叠加型 UI 统一字体栈（与 tokens.css 的 --font-body 同源：仅开源可商用字体名）。 */
export const OVERLAY_FONT_STACK =
  "'Noto Sans SC', 'Source Han Sans SC', 'Noto Sans CJK SC', Inter, Roboto, 'DejaVu Sans', sans-serif";

/**
 * 液态玻璃卡片（划词查词卡 / 输入框翻译浮层）——Apple Liquid Glass 语言。
 *
 * 规范落点：强模糊 + 饱和度提升的 backdrop（玻璃感来源）、半透明面而非实色、
 * 顶部镜面高光（specular）、1px 亮边 + 内描边、超椭圆大圆角、三层柔和投影
 * （接触 + 中距 + 远距）、浅深模式跟随系统自适应、交互控件用半透明填充而
 * 非描边按钮、焦点环用系统蓝。
 *
 * 两个工程约束：
 * - 变量前缀 --moyi-glass-* 而非 --overlay-*：本文件是 tokens.css 的镜像契约
 *   （tests/token-parity.test.ts 守护 --overlay-* 组），玻璃变量自成一套不参与镜像；
 * - backdrop-filter 先声明背景色再声明滤镜：不支持滤镜的内核自动落到更实的底色，
 *   可读性不塌。
 */
export const GLASS_OVERLAY_CSS = `
  --moyi-glass-bg: rgba(252, 252, 254, 0.72);
  --moyi-glass-fill: rgba(255, 255, 255, 0.5);
  --moyi-glass-fill-hover: rgba(255, 255, 255, 0.74);
  --moyi-glass-border: rgba(255, 255, 255, 0.66);
  --moyi-glass-edge: rgba(0, 0, 0, 0.09);
  --moyi-glass-specular: rgba(255, 255, 255, 0.72);
  --moyi-glass-sheen: rgba(255, 255, 255, 0.38);
  --moyi-glass-label: rgba(24, 24, 27, 0.92);
  --moyi-glass-label-2: rgba(60, 60, 67, 0.72);
  --moyi-glass-label-3: rgba(60, 60, 67, 0.5);
  --moyi-glass-accent: #0a84ff;
  --moyi-glass-success: #248a3d;
  --moyi-glass-danger: #d70015;
  --moyi-glass-radius: 18px;
  --moyi-glass-radius-sm: 10px;
  --moyi-glass-blur: 22px;
  --moyi-glass-shadow:
    0 1px 2px rgba(0, 0, 0, 0.05),
    0 10px 26px rgba(0, 0, 0, 0.1),
    0 28px 56px rgba(0, 0, 0, 0.08);
  @media (prefers-color-scheme: dark) {
    --moyi-glass-bg: rgba(26, 26, 28, 0.6);
    --moyi-glass-fill: rgba(255, 255, 255, 0.13);
    --moyi-glass-fill-hover: rgba(255, 255, 255, 0.22);
    --moyi-glass-border: rgba(255, 255, 255, 0.2);
    --moyi-glass-edge: rgba(255, 255, 255, 0.12);
    --moyi-glass-specular: rgba(255, 255, 255, 0.2);
    --moyi-glass-sheen: rgba(255, 255, 255, 0.07);
    --moyi-glass-label: rgba(245, 245, 247, 0.95);
    --moyi-glass-label-2: rgba(235, 235, 245, 0.66);
    --moyi-glass-label-3: rgba(235, 235, 245, 0.45);
    --moyi-glass-success: #30d158;
    --moyi-glass-shadow:
      0 1px 2px rgba(0, 0, 0, 0.3),
      0 10px 28px rgba(0, 0, 0, 0.32),
      0 28px 56px rgba(0, 0, 0, 0.24);
  }
`;
