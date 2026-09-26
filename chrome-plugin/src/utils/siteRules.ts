/**
 * 站点规则（Site Rules）：让用户修复「剪枝误伤 / 漏翻」的站点——这是开箱管线之外
 * 唯一的补救通道，也是社区生态（规则仓库）的基础件。
 *
 * v1 语义（与《功能立项-T8站点规则-实施计划》一致）：
 * - exclude：命中的元素及其子树不进入候选（与硬剪枝同层早退）；
 * - forceInclude：命中的元素**旁路**剪枝器直接补充为候选——v1 不改写剪枝谓词
 *   （那是整篇翻译的地基），而是加一条独立的发现通道；
 * - 三层优先级：个人 > 订阅 > 全局默认——订阅规则先铺底，个人规则后覆盖
 *   （个人 include 追加、exclude 优先），个人永远压订阅。
 *
 * 安全：选择器是用户/仓库输入，一律校验后使用；坏选择器只丢该条不炸管线。
 */

export type SiteRuleSource = 'personal' | 'subscribed';

export interface SiteRule {
  id: string;
  name: string;
  /** 站点匹配：`example.com` 精确 / `*.example.com` 含子域（也匹配 apex）。 */
  hostPattern: string;
  includeSelectors: string[];
  excludeSelectors: string[];
  /** 把被剪枝器漏掉的元素捞回来（.notranslate 误标、hidden 包裹的正文等）。 */
  forceInclude: boolean;
  enabled: boolean;
  source: SiteRuleSource;
}

export const SITE_RULES_MAX = 50;
const RULE_SELECTORS_MAX = 8;
const SELECTOR_MAX_CHARS = 200;

/** 编译后的站点规则集：引擎只认这个形态。 */
export interface CompiledRuleSet {
  include: string[];
  exclude: string[];
  forceInclude: boolean;
}

export const EMPTY_RULE_SET: CompiledRuleSet = { include: [], exclude: [], forceInclude: false };

/** 选择器可用性预校验：一次 querySelector 试验，坏选择器直接出局。 */
export const isValidSelector = (selector: string): boolean => {
  if (!selector || selector.length > SELECTOR_MAX_CHARS) return false;
  try {
    document.querySelector(selector);
    return true;
  } catch {
    return false;
  }
};

const sanitizeSelectors = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const selector = raw.trim().replace(/\s+/g, ' ');
    if (!selector || out.includes(selector)) continue;
    if (!isValidSelector(selector)) continue;
    out.push(selector);
    if (out.length >= RULE_SELECTORS_MAX) break;
  }
  return out;
};

export const sanitizeSiteRules = (value: unknown): SiteRule[] => {
  if (!Array.isArray(value)) return [];
  const out: SiteRule[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as Partial<SiteRule>;
    const hostPattern = typeof candidate.hostPattern === 'string' ? candidate.hostPattern.trim().toLowerCase().slice(0, 120) : '';
    const name = typeof candidate.name === 'string' ? candidate.name.trim().slice(0, 40) : '';
    if (!hostPattern || !name) continue;
    const id = typeof candidate.id === 'string' && candidate.id ? candidate.id.slice(0, 64) : `r-${out.length}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name,
      hostPattern,
      includeSelectors: sanitizeSelectors(candidate.includeSelectors),
      excludeSelectors: sanitizeSelectors(candidate.excludeSelectors),
      forceInclude: candidate.forceInclude === true,
      enabled: candidate.enabled !== false,
      source: candidate.source === 'subscribed' ? 'subscribed' : 'personal',
    });
    if (out.length >= SITE_RULES_MAX) break;
  }
  return out;
};

/** 订阅 URL 列表清洗：仅 http(s)，去重，上限 5（拉取放大攻击面）。 */
export const sanitizeRuleSubscriptions = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const url = raw.trim();
    if (!/^https?:\/\//i.test(url) || out.includes(url)) continue;
    out.push(url.slice(0, 500));
    if (out.length >= 5) break;
  }
  return out;
};

/** 站点匹配：精确 / `*.example.com`（含 apex）/ 前导 `.`；大小写与端口不敏感。 */
export const matchesHost = (pattern: string, hostname: string): boolean => {
  const p = pattern.trim().toLowerCase();
  const host = hostname.trim().toLowerCase();
  if (!p || !host) return false;
  if (p === '*') return true;
  if (p.startsWith('*.')) {
    const apex = p.slice(2);
    return host === apex || host.endsWith(`.${apex}`);
  }
  if (p.startsWith('.')) return host === p.slice(1) || host.endsWith(p);
  return host === p;
};

export const rulesForHost = (rules: readonly SiteRule[], hostname: string): SiteRule[] =>
  rules.filter((rule) => rule.enabled && matchesHost(rule.hostPattern, hostname));

/**
 * 三层合并：订阅铺底 → 个人覆盖（个人 include 追加、exclude 无条件优先）；
 * forceInclude 取任一层为真即生效（个人可以「打开」订阅规则没开的强捞）。
 */
export const compileRuleSet = (
  rules: readonly SiteRule[],
  hostname: string,
): CompiledRuleSet => {
  const active = rulesForHost(rules, hostname);
  if (active.length === 0) return EMPTY_RULE_SET;
  const subscribed = active.filter((rule) => rule.source === 'subscribed');
  const personal = active.filter((rule) => rule.source === 'personal');
  const include: string[] = [];
  const exclude: string[] = [];
  for (const rule of [...subscribed, ...personal]) {
    for (const selector of rule.includeSelectors) {
      if (!include.includes(selector)) include.push(selector);
    }
    for (const selector of rule.excludeSelectors) {
      if (!exclude.includes(selector)) exclude.push(selector);
    }
  }
  const forceInclude = active.some((rule) => rule.forceInclude);
  if (include.length === 0 && exclude.length === 0 && !forceInclude) return EMPTY_RULE_SET;
  return { include, exclude, forceInclude };
};

/** 选择器命中判定（坏选择器运行时兜底：异常等价于不命中）。 */
export const matchesAnySelector = (element: Element, selectors: readonly string[]): boolean => {
  for (const selector of selectors) {
    try {
      if (element.matches(selector)) return true;
    } catch {
      // 坏选择器：不命中
    }
  }
  return false;
};

// ── 设置页规则编辑器的表单逻辑（纯函数，判断不留 UI）──

/** 规则表单原始输入（多行选择器以文本形式传入）。 */
export interface RuleFormInput {
  name: string;
  hostPattern: string;
  includeText: string;
  excludeText: string;
  forceInclude: boolean;
}

/** 多行文本 → 选择器数组：逐行 trim、去空、去重（语法校验在保存时的 sanitize 里做）。 */
export const parseSelectorLines = (text: string): string[] => {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const selector = line.trim().replace(/\s+/g, ' ');
    if (selector && !out.includes(selector)) out.push(selector);
  }
  return out;
};

export type RuleFormError = 'missing-name-host' | 'empty-rule';

/** 表单 → 规则（或可读错误）。空选择器且未勾强捞 = 空规则，拒绝保存。 */
export const buildRuleFromForm = (
  form: RuleFormInput,
  id: string,
): { rule: SiteRule; error?: undefined } | { rule?: undefined; error: RuleFormError } => {
  const name = form.name.trim();
  const hostPattern = form.hostPattern.trim();
  if (!name || !hostPattern) return { error: 'missing-name-host' };
  const includeSelectors = parseSelectorLines(form.includeText);
  const excludeSelectors = parseSelectorLines(form.excludeText);
  if (includeSelectors.length === 0 && excludeSelectors.length === 0 && !form.forceInclude) {
    return { error: 'empty-rule' };
  }
  return {
    rule: {
      id,
      name,
      hostPattern: hostPattern.toLowerCase(),
      includeSelectors,
      excludeSelectors,
      forceInclude: form.forceInclude,
      enabled: true,
      source: 'personal',
    },
  };
};

export interface RuleEditResult {
  rules: SiteRule[];
  mode: 'created' | 'updated';
  /** 被 sanitize 剔除的条目数（无效选择器等）——UI 据此提示用户。 */
  dropped: number;
}

/** 新建或更新（editingId 为空串 = 新建）。返回清洗后的规则表。 */
export const applyRuleEdit = (
  rules: readonly SiteRule[],
  editingId: string,
  rule: SiteRule,
): RuleEditResult => {
  const mode: RuleEditResult['mode'] = editingId ? 'updated' : 'created';
  const next = editingId ? rules.map((item) => (item.id === editingId ? rule : item)) : [...rules, rule];
  const sanitized = sanitizeSiteRules(next);
  return { rules: sanitized, mode, dropped: next.length - sanitized.length };
};

/** 规则列表副标题：host · 强捞 · +include · -exclude。 */
export const summarizeRule = (rule: SiteRule): string => {
  const bits = [rule.hostPattern];
  if (rule.forceInclude) bits.push('强捞');
  if (rule.includeSelectors.length > 0) bits.push('+' + rule.includeSelectors.join(', '));
  if (rule.excludeSelectors.length > 0) bits.push('-' + rule.excludeSelectors.join(', '));
  return bits.join(' · ');
};
