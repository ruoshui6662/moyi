import { shouldSkipTextNode } from './dom';
import type { TextExtractionOptions } from './types';

const IDENTIFIER_PATTERNS = [
  /^https?:\/\//i,
  /^(?:www\.)/i,
  /^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i,
  /^[\w./-]+\.(?:ts|tsx|js|jsx|json|css|html|py|java|go|rs)$/i,
  /^[\da-f]+$/i,
];

export const normalizeText = (value: string): string =>
  value.replace(/[\t\r\n ]+/g, ' ').replace(/\u00a0/g, ' ').trim();

export const isIdentifierLikeText = (value: string): boolean =>
  IDENTIFIER_PATTERNS.some((pattern) => pattern.test(value)) || /^\d[\d\s.,:/-]*$/.test(value);

export const isMeaningfulText = (value: string): boolean => {
  const normalized = normalizeText(value);
  if (normalized.length < 2 || isIdentifierLikeText(normalized)) return false;
  return /[\p{L}]/u.test(normalized);
};

export const extractText = (
  element: HTMLElement,
  options: TextExtractionOptions = {},
): string => {
  const maxCharacters = options.maxCharacters ?? 20_000;
  const maxDepth = options.maxDepth ?? 512;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  let node: Node | null;
  let characters = 0;

  while ((node = walker.nextNode())) {
    const textNode = node as Text;
    if (shouldSkipTextNode(textNode, maxDepth)) continue;
    const value = normalizeText(textNode.nodeValue ?? '');
    if (!value) continue;
    parts.push(value);
    characters += value.length;
    if (characters >= maxCharacters) break;
  }

  return normalizeText(parts.join(' '));
};
