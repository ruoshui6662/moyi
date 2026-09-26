import { beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_RULE_SET,
  SITE_RULES_MAX,
  compileRuleSet,
  isValidSelector,
  matchesAnySelector,
  matchesHost,
  rulesForHost,
  sanitizeRuleSubscriptions,
  sanitizeSiteRules,
  type SiteRule,
  applyRuleEdit,
  buildRuleFromForm,
  parseSelectorLines,
  summarizeRule,
} from '../chrome-plugin/src/utils/siteRules';
import { findTranslationCandidates } from '../chrome-plugin/src/translation-core';

const rule = (overrides: Partial<SiteRule> = {}): SiteRule => ({
  id: 'r1',
  name: '测试规则',
  hostPattern: 'example.com',
  includeSelectors: [],
  excludeSelectors: [],
  forceInclude: false,
  enabled: true,
  source: 'personal',
  ...overrides,
});

describe('matchesHost', () => {
  it('精确匹配忽略大小写与端口', () => {
    expect(matchesHost('example.com', 'example.com')).toBe(true);
    expect(matchesHost('EXAMPLE.com', 'Example.COM')).toBe(true);
    expect(matchesHost('example.com', 'other.com')).toBe(false);
  });

  it('*. 通配含子域与 apex', () => {
    expect(matchesHost('*.example.com', 'docs.example.com')).toBe(true);
    expect(matchesHost('*.example.com', 'example.com')).toBe(true);
    expect(matchesHost('*.example.com', 'notexample.com')).toBe(false);
  });

  it('前导点等价通配；* 全匹配；空值不匹配', () => {
    expect(matchesHost('.example.com', 'a.example.com')).toBe(true);
    expect(matchesHost('*', 'anything.dev')).toBe(true);
    expect(matchesHost('', 'example.com')).toBe(false);
  });
});

describe('sanitizeSiteRules', () => {
  it('丢弃无名/无 host/坏选择器条目，去重 id 并限长', () => {
    const rules = sanitizeSiteRules([
      { name: '', hostPattern: 'a.com' },
      { name: 'x', hostPattern: '' },
      rule({ id: 'ok', includeSelectors: ['article', 'article', '::::bad::::', 'p'] }),
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.includeSelectors).toEqual(['article', 'p']);
  });

  it('条数上限 SITE_RULES_MAX', () => {
    const many = Array.from({ length: SITE_RULES_MAX + 10 }, (_, i) => rule({ id: `r${i}` }));
    expect(sanitizeSiteRules(many)).toHaveLength(SITE_RULES_MAX);
  });

  it('host 归一化（trim/小写），source 枚举收敛', () => {
    const [normalized] = sanitizeSiteRules([rule({ hostPattern: '  Docs.Example.COM ', source: 'weird' as never })]);
    expect(normalized?.hostPattern).toBe('docs.example.com');
    expect(normalized?.source).toBe('personal');
  });
});

describe('sanitizeRuleSubscriptions', () => {
  it('仅 http(s)、去重、上限 5', () => {
    const urls = sanitizeRuleSubscriptions([
      'https://a.com/rules.json',
      'https://a.com/rules.json',
      'javascript:alert(1)',
      'not-a-url',
      ...Array.from({ length: 8 }, (_, i) => 'https://r' + i + '.dev/rules.json'),
    ]);
    expect(urls).toHaveLength(5);
    expect(urls[0]).toBe('https://a.com/rules.json');
    expect(urls.every((url) => url.startsWith('http'))).toBe(true);
  });
});

describe('三层合并（个人 > 订阅 > 默认）', () => {
  const subscribed = rule({ id: 's', source: 'subscribed', includeSelectors: ['.post', '.comment'], excludeSelectors: ['.ad'] });
  const personal = rule({ id: 'p', source: 'personal', includeSelectors: ['.article'], forceInclude: true });

  it('订阅铺底 + 个人追加 include，排除项合并', () => {
    const compiled = compileRuleSet([subscribed, personal], 'example.com');
    expect(compiled.include).toEqual(['.post', '.comment', '.article']);
    expect(compiled.exclude).toEqual(['.ad']);
    expect(compiled.forceInclude).toBe(true);
  });

  it('不匹配站点/空规则返回 EMPTY（默认路径零开销）', () => {
    expect(compileRuleSet([subscribed, personal], 'other.com')).toBe(EMPTY_RULE_SET);
    expect(compileRuleSet([], 'example.com')).toBe(EMPTY_RULE_SET);
    expect(compileRuleSet([rule({ includeSelectors: [] })], 'example.com')).toBe(EMPTY_RULE_SET);
  });

  it('禁用的规则不参与', () => {
    expect(rulesForHost([rule({ enabled: false, includeSelectors: ['p'] })], 'example.com')).toEqual([]);
    expect(compileRuleSet([rule({ enabled: false, includeSelectors: ['p'] })], 'example.com')).toBe(EMPTY_RULE_SET);
  });
});

describe('选择器防御', () => {
  it('isValidSelector：坏选择器出局', () => {
    expect(isValidSelector('article .title')).toBe(true);
    expect(isValidSelector('::::bad')).toBe(false);
    expect(isValidSelector('')).toBe(false);
  });

  it('matchesAnySelector：运行时坏选择器等价于不命中', () => {
    const div = document.createElement('div');
    div.className = 'post';
    expect(matchesAnySelector(div, ['.post'])).toBe(true);
    expect(matchesAnySelector(div, ['::::bad', '.nope'])).toBe(false);
  });
});

describe('引擎接线：exclude 早退 + forceInclude 旁路（DOM 集成）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('默认路径（空规则集）与旧行为一致：.notranslate 正文不翻', () => {
    document.body.innerHTML = `
      <article><p>Visible paragraph that should be discovered.</p></article>
      <div class="notranslate"><p>Hidden away by the pruner.</p></div>`;
    const texts = findTranslationCandidates(document.body).map((c) => c.text);
    expect(texts.join(' ')).toContain('Visible paragraph');
    expect(texts.join(' ')).not.toContain('Hidden away');
  });

  it('forceInclude 把误标 .notranslate 的正文捞回来', () => {
    document.body.innerHTML = `
      <article><p>Visible paragraph that should be discovered.</p></article>
      <div class="notranslate"><p>Hidden away by the pruner.</p></div>`;
    const texts = findTranslationCandidates(document.body, 100, undefined, {
      include: ['.notranslate p'], exclude: [], forceInclude: true,
    }).map((c) => c.text);
    expect(texts.join(' ')).toContain('Visible paragraph');
    expect(texts.join(' ')).toContain('Hidden away');
  });

  it('exclude 早退：命中的子树整棵不进入候选', () => {
    document.body.innerHTML = `
      <article><p>Keep this paragraph translated.</p></article>
      <aside class="sidebar"><p>Sidebar noise.</p></aside>`;
    const texts = findTranslationCandidates(document.body, 100, undefined, {
      include: [], exclude: ['.sidebar'], forceInclude: false,
    }).map((c) => c.text);
    expect(texts.join(' ')).toContain('Keep this paragraph');
    expect(texts.join(' ')).not.toContain('Sidebar noise');
  });

  it('防御：自有译文节点与输入域不因 forceInclude 被捞', () => {
    document.body.innerHTML = `
      <div class="notranslate">
        <p data-personal-translator-owned>Already translated output.</p>
        <input value="user typed text" />
        <p>Genuine missed article body.</p>
      </div>`;
    const texts = findTranslationCandidates(document.body, 100, undefined, {
      include: ['.notranslate p', '.notranslate input'], exclude: [], forceInclude: true,
    }).map((c) => c.text);
    expect(texts.join(' ')).toContain('Genuine missed article body');
    expect(texts.join(' ')).not.toContain('Already translated output');
    expect(texts.join(' ')).not.toContain('user typed text');
  });

  it('坏选择器不中断管线（静默跳过该条）', () => {
    document.body.innerHTML = '<article><p>Normal readable content here.</p></article>';
    const texts = findTranslationCandidates(document.body, 100, undefined, {
      include: ['::::bad::::'], exclude: [], forceInclude: true,
    }).map((c) => c.text);
    expect(texts.join(' ')).toContain('Normal readable content');
  });
});

describe('设置页规则编辑器：表单逻辑（纯函数）', () => {
  it('多行文本 → 选择器：逐行 trim、去空、去重、内部空白归一', () => {
    expect(parseSelectorLines('  .a  \n\n.b   c\n.a\n')).toEqual(['.a', '.b c']);
  });

  it('缺名称或 host → missing-name-host；空选择器且未强捞 → empty-rule', () => {
    const base = { name: 'r', hostPattern: 'a.com', includeText: 'p', excludeText: '', forceInclude: false };
    expect(buildRuleFromForm({ ...base, name: '  ' }, 'x').error).toBe('missing-name-host');
    expect(buildRuleFromForm({ ...base, hostPattern: '' }, 'x').error).toBe('missing-name-host');
    expect(buildRuleFromForm({ ...base, includeText: ' \n' }, 'x').error).toBe('empty-rule');
    // 仅勾强捞、无选择器：允许（后续 sanitize 保留 forceInclude）
    expect(buildRuleFromForm({ ...base, includeText: '', forceInclude: true }, 'x').rule?.forceInclude).toBe(true);
  });

  it('构建的规则：host 小写化、source=personal、enabled=true', () => {
    const built = buildRuleFromForm({
      name: '  正文强捞 ', hostPattern: ' Docs.Example.COM ', includeText: '.body', excludeText: '.ad', forceInclude: true,
    }, 'p-1');
    expect(built.rule).toMatchObject({ id: 'p-1', name: '正文强捞', hostPattern: 'docs.example.com', forceInclude: true, source: 'personal', enabled: true });
  });

  it('applyRuleEdit：新建追加、编辑替换、坏选择器计入 dropped', () => {
    const existing = sanitizeSiteRules([{ name: 'a', hostPattern: 'a.com', includeSelectors: ['p'], forceInclude: true, id: 'r1' }]);
    const created = applyRuleEdit(existing, '', { id: 'r2', name: 'b', hostPattern: 'b.com', includeSelectors: ['p'], excludeSelectors: [], forceInclude: true, enabled: true, source: 'personal' });
    expect(created.mode).toBe('created');
    expect(created.rules).toHaveLength(2);
    const updated = applyRuleEdit(existing, 'r1', { ...existing[0], name: '改名' });
    expect(updated.mode).toBe('updated');
    expect(updated.rules).toHaveLength(1);
    expect(updated.rules[0]?.name).toBe('改名');
    // 坏选择器在 sanitize 里被剔除，但规则本身保留（是否为空规则由表单层 empty-rule 把关）
    const cleaned = applyRuleEdit([], '', { id: 'r3', name: 'c', hostPattern: 'c.com', includeSelectors: ['::::bad::::'], excludeSelectors: [], forceInclude: false, enabled: true, source: 'personal' });
    expect(cleaned.rules).toHaveLength(1);
    expect(cleaned.rules[0]?.includeSelectors).toEqual([]);
    expect(cleaned.dropped).toBe(0);
    // 真正会被 sanitize 丢弃的是结构性非法条目（缺名称）
    const droppedCase = applyRuleEdit([], '', { id: 'r4', name: '', hostPattern: 'd.com', includeSelectors: ['p'], excludeSelectors: [], forceInclude: true, enabled: true, source: 'personal' });
    expect(droppedCase.rules).toHaveLength(0);
    expect(droppedCase.dropped).toBe(1);
  });

  it('summarizeRule：host + 强捞标记 + include/exclude 摘要', () => {
    const [rule] = sanitizeSiteRules([{ name: 'r', hostPattern: 'a.com', includeSelectors: ['.x', '.y'], excludeSelectors: ['.z'], forceInclude: true, id: 'r1' }]);
    expect(summarizeRule(rule!)).toBe('a.com · 强捞 · +.x, .y · -.z');
    const [plain] = sanitizeSiteRules([{ name: 'r', hostPattern: 'b.com', includeSelectors: [], excludeSelectors: [], forceInclude: false, id: 'r2' }]);
    expect(summarizeRule(plain!)).toBe('b.com');
  });
});
