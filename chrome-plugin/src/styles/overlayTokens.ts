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
