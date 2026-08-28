import type { ElementTypography } from './typography';

export interface TranslationCandidate {
  element: HTMLElement;
  text: string;
  typography: ElementTypography;
}

export interface TextExtractionOptions {
  maxDepth?: number;
  maxCharacters?: number;
}
