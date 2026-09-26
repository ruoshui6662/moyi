import type { ElementTypography } from './typography';

export interface TranslationCandidate {
  element: HTMLElement;
  text: string;
  typography: ElementTypography;
}

export interface TextExtractionOptions {
  maxDepth?: number;
  maxCharacters?: number;
  /** 站点规则强捞通道：忽略 .notranslate / hidden / aria-hidden 等保护标记，
   *  仅保留脚本/样式类标签的文本排除（见 text.ts 的 hasScriptAncestor）。 */
  ignoreProtectedAncestors?: boolean;
}
