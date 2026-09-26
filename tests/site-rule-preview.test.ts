import { afterEach, describe, expect, it } from 'vitest';
import {
  PREVIEW_RULES_EVENT,
  PREVIEW_STYLE_ID,
  countRuleMatches,
} from '../chrome-plugin/src/entrypoints/content/siteRulePreview';
import { compileRuleSet, sanitizeSiteRules } from '../chrome-plugin/src/utils/siteRules';

describe('站点规则试运行', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    document.getElementById(PREVIEW_STYLE_ID)?.remove();
  });

  it('事件名对外稳定（控制台命令的契约）', () => {
    expect(PREVIEW_RULES_EVENT).toBe('moyi:preview-site-rules');
  });

  it('countRuleMatches 统计 include/exclude 命中数并报告无规则', () => {
    document.body.innerHTML = '<div class="notranslate"><p>a</p><p>b</p></div><aside class="ad">x</aside>';
    const rules = compileRuleSet(sanitizeSiteRules([{
      name: 'r', hostPattern: 'example.com', includeSelectors: ['.notranslate p'], excludeSelectors: ['.ad'], forceInclude: true,
    }]), 'example.com');
    const result = countRuleMatches(rules);
    expect(result.active).toBe(true);
    expect(result.include).toBe(2);
    expect(result.exclude).toBe(1);
    expect(countRuleMatches(compileRuleSet([], 'example.com')).active).toBe(false);
  });
});
