/**
 * 元素 → CSS 选择器（拾取器核心，纯逻辑，依赖 document 做唯一性校验）。
 *
 * 生成策略按「可读性 → 稳定性 → 唯一性」贪心：
 * 1. 唯一且合法的 id（`#id`）——最稳；
 * 2. 自身「tag.class1.class2」（类名按出现顺序取前两个，且跳过数字开头的哈希类）；
 * 3. 逐级向上拼路径（最多 MAX_DEPTH 级），每加一级都用 querySelectorAll 验证唯一；
 * 4. 兜底 nth-of-type 链，保证在浅 DOM 里总能定位；
 * 5. 达到深度上限仍不唯一 → 返回最佳候选并置 unique=false，由 UI 提示用户补限定。
 */

/** 路径最大层级；再深对用户也不可读，直接转 nth 兜底。 */
export const MAX_SELECTOR_DEPTH = 5;

const isValidId = (value: string): boolean => /^[A-Za-z][\w-]*$/.test(value) && !/^\d/.test(value);
const isStableClass = (value: string): boolean => value.length > 0 && value.length <= 40 && !/^\d/.test(value) && !/^(css|sc|jsx|ng|v-|[a-z]+-[0-9a-f]{4,})/i.test(value);

const escapeIdent = (value: string): string =>
  /^[A-Za-z_][\w-]*$/.test(value) ? value : value.replace(/([^\w-])/g, '\\$1');

const isUnique = (selector: string): boolean => {
  try {
    return document.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
};

/** 当前元素在父级下的同类序号（nth-of-type，1 起）。 */
const nthOfType = (element: Element): number => {
  const parent = element.parentElement;
  if (!parent) return 1;
  const sameTag = Array.from(parent.children).filter((child) => child.tagName === element.tagName);
  return sameTag.indexOf(element) + 1;
};

export interface SelectorResult {
  selector: string;
  /** 在当前文档中是否唯一定位；false 时 UI 应提示补限定。 */
  unique: boolean;
  /** 简报（tag.class#id）用于确认拾对了元素。 */
  label: string;
}

const classPart = (element: Element): string => {
  const classes = Array.from(element.classList).filter(isStableClass).slice(0, 2);
  return classes.map((name) => '.' + escapeIdent(name)).join('');
};

const stepFor = (element: Element, useNth: boolean): string => {
  const tag = element.tagName.toLowerCase();
  const own = tag + classPart(element);
  if (useNth) return `${tag}:nth-of-type(${nthOfType(element)})`;
  return own;
};

export const buildElementSelector = (element: Element): SelectorResult => {
  const tag = element.tagName.toLowerCase();
  const id = element.id;
  const label = tag + (id ? '#' + id : '') + (element.classList.length > 0 ? '.' + Array.from(element.classList).join('.') : '');

  // ① 唯一 id
  if (id && isValidId(id)) {
    const selector = `#${escapeIdent(id)}`;
    if (isUnique(selector)) return { selector, unique: true, label };
  }

  // ② 自身 tag.classes
  const own = stepFor(element, false);
  if (isUnique(own)) return { selector: own, unique: true, label };

  // ③ 逐级向上拼路径（每级验证唯一；自身已试过，从父级开始）
  const chain: string[] = [own];
  let current: Element | null = element;
  let depth = 0;
  while (current.parentElement && depth < MAX_SELECTOR_DEPTH) {
    current = current.parentElement;
    chain.unshift(stepFor(current, false));
    depth += 1;
    const candidate = chain.join(' > ');
    if (isUnique(candidate)) return { selector: candidate, unique: true, label };
  }

  // ④ nth-of-type 兜底（保证浅 DOM 内可定位）
  const nthChain: string[] = [];
  current = element;
  depth = 0;
  while (current && depth < MAX_SELECTOR_DEPTH + 1) {
    nthChain.unshift(stepFor(current, true));
    depth += 1;
    const candidate = nthChain.join(' > ');
    if (isUnique(candidate)) return { selector: candidate, unique: true, label };
    current = current.parentElement;
  }

  // ⑤ 深度封顶仍不唯一：返回最佳候选并标记
  return { selector: chain.join(' > '), unique: false, label };
};
