const HARD_PRUNE_TAGS = new Set([
  'HEAD', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'INPUT', 'TEXTAREA',
  'SELECT', 'OPTION', 'MATH', 'SVG', 'CANVAS', 'AUDIO', 'VIDEO', 'OBJECT',
  'TEMPLATE', 'PRE', 'CODE', 'KBD', 'SAMP', 'VAR',
]);

export const isHardPruneElement = (element: Element): boolean => {
  if (HARD_PRUNE_TAGS.has(element.tagName)) return true;
  if (element.matches('[translate="no"], .notranslate, [data-notranslate]')) return true;
  if (element.hasAttribute('contenteditable')) return true;
  if (element.hasAttribute('hidden') || element.hasAttribute('inert')) return true;
  if (element.getAttribute('aria-hidden') === 'true') return true;
  if (element.matches('.sr-only, .visually-hidden, .MathJax, .katex, mjx-container')) return true;
  if (element.matches('[data-personal-translator-owned]')) return true;
  return false;
};

export const hasProtectedAncestor = (element: Element, maxDepth = 512): boolean => {
  let current: Element | null = element;
  let depth = 0;
  while (current && depth++ < maxDepth) {
    if (isHardPruneElement(current)) return true;
    current = current.parentElement;
  }
  return depth >= maxDepth;
};

export const shouldSkipTextNode = (node: Text, maxDepth = 512): boolean => {
  const parent = node.parentElement;
  return !parent || hasProtectedAncestor(parent, maxDepth);
};
