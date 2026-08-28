const INLINE_TAGS = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'EM', 'FONT', 'I', 'IMG',
  'KBD', 'MARK', 'Q', 'RUBY', 'S', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP',
  'TIME', 'U', 'WBR',
]);

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'SECTION', 'TABLE', 'TBODY', 'TD',
  'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);

/** 交互控件与嵌入内容：不注入译文，避免改变控件尺寸或嵌入布局。 */
const INTERACTIVE_TAGS = new Set([
  'AUDIO', 'BUTTON', 'CANVAS', 'EMBED', 'IFRAME', 'INPUT', 'LABEL',
  'OBJECT', 'SELECT', 'TEXTAREA', 'VIDEO',
]);

/** 表结构行/组：在其中挂译文会产生匿名表格单元，必须排除。 */
const TABLE_STRUCTURE_TAGS = new Set(['TABLE', 'TBODY', 'TFOOT', 'THEAD', 'TR']);

const isUnsafeDisplay = (display: string): boolean =>
  display === 'flex' ||
  display === 'inline-flex' ||
  display === 'grid' ||
  display === 'inline-grid' ||
  display === 'contents' ||
  display === 'table' ||
  display === 'table-row' ||
  display === 'table-column' ||
  display === 'table-column-group' ||
  display === 'table-header-group' ||
  display === 'table-footer-group' ||
  display === 'table-row-group';

export const isBlockElement = (element: HTMLElement): boolean => {
  if (BLOCK_TAGS.has(element.tagName)) return true;
  if (INLINE_TAGS.has(element.tagName)) return false;
  if (typeof getComputedStyle !== 'function') return true;
  const display = getComputedStyle(element).display;
  return display !== 'inline' && display !== 'inline-block' && display !== 'none';
};

/**
 * 判断元素是否可作为译文挂载点：排除交互/嵌入控件、表结构行/组，
 * 以及 flex/grid/contents 等会把译文当成额外布局单元的容器。
 * TD/TH 保留为候选（table cell 内部挂载合法），单独排除行/组。
 */
export const isCandidateContainer = (element: HTMLElement): boolean => {
  if (INTERACTIVE_TAGS.has(element.tagName)) return false;
  if (TABLE_STRUCTURE_TAGS.has(element.tagName)) return false;
  if (typeof getComputedStyle !== 'function') return true;
  const display = getComputedStyle(element).display;
  if (isUnsafeDisplay(display)) return false;
  if (display === 'inline-table') return false;
  return true;
};
