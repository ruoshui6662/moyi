import { hasProtectedAncestor } from './dom';
import { isBlockElement, isCandidateContainer } from './layout';
import { extractText, isMeaningfulText } from './text';
import { captureElementTypography } from './typography';
import type { TranslationCandidate } from './types';

const isVisible = (element: HTMLElement): boolean => {
  if (element.getAttribute('aria-hidden') === 'true' || element.hidden) return false;
  if (typeof getComputedStyle !== 'function') return true;
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
};

export const findTranslationCandidates = (
  root: HTMLElement = document.body,
  maxCandidates = 100,
): TranslationCandidate[] => {
  const candidates: TranslationCandidate[] = [];
  const seen = new Set<HTMLElement>();
  const ancestorSet = new Set<HTMLElement>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node: Node | null;

  const markAncestors = (element: HTMLElement): void => {
    let parent: HTMLElement | null = element.parentElement;
    while (parent && !seen.has(parent)) {
      ancestorSet.add(parent);
      parent = parent.parentElement;
    }
  };

  while ((node = walker.nextNode()) && candidates.length < maxCandidates) {
    const element = node as HTMLElement;
    if (seen.has(element) || ancestorSet.has(element) || hasProtectedAncestor(element) || !isVisible(element)) continue;
    if (!isBlockElement(element) || !isCandidateContainer(element)) continue;

    const text = extractText(element, { maxCharacters: 8_000 });
    if (!isMeaningfulText(text)) continue;

    const childBlocks = Array.from(element.children).filter(
      (child) => child instanceof HTMLElement && isBlockElement(child),
    );
    if (childBlocks.some((child) => extractText(child as HTMLElement, { maxCharacters: 8_000 }).length >= text.length * 0.8)) {
      continue;
    }
    const totalChildTextLength = childBlocks.reduce(
      (sum, child) => sum + extractText(child as HTMLElement, { maxCharacters: 8_000 }).length,
      0,
    );
    if (totalChildTextLength >= text.length * 0.8) {
      continue;
    }

    seen.add(element);
    markAncestors(element);
    candidates.push({
      element,
      text,
      typography: captureElementTypography(element),
    });
  }

  return deduplicateCandidates(candidates);
};

const deduplicateCandidates = (candidates: TranslationCandidate[]): TranslationCandidate[] => {
  const result: TranslationCandidate[] = [];
  for (const candidate of candidates) {
    const isAncestor = candidates.some(
      (other) => other.element !== candidate.element && candidate.element.contains(other.element),
    );
    if (!isAncestor) {
      result.push(candidate);
    }
  }
  return result;
};
