/**
 * 站点规则试运行：在目标页高亮规则命中元素并回报命中数（设置页「试运行」的落地端）。
 *
 * 为什么走 CustomEvent 而不是把预览做进设置页：设置页在扩展域，**看不到目标网页的
 * DOM**——规则必须在目标页的文档上下文里求值。页面控制台一行命令
 * `document.dispatchEvent(new CustomEvent('moyi:preview-site-rules'))` 即可，
 * 不需要开放任何页面 → 扩展的外部消息端口（那会扩大攻击面）。
 *
 * 生命周期：高亮样式挂在一个临时 <style> 上，5 秒后自动移除；重复触发先清旧的。
 */

import type { CompiledRuleSet } from '../../utils/siteRules';

export const PREVIEW_RULES_EVENT = 'moyi:preview-site-rules';
export const PREVIEW_STYLE_ID = 'moyi-site-rule-preview';
const PREVIEW_TTL_MS = 5000;

const COLORS = ['#ff2d55', '#0a84ff', '#30d158', '#ffd60a', '#bf5af2'];

interface PreviewResult {
  include: number;
  exclude: number;
  active: boolean;
}

const preview = (ruleSet: CompiledRuleSet): PreviewResult => {
  document.getElementById(PREVIEW_STYLE_ID)?.remove();
  if (ruleSet.include.length === 0 && ruleSet.exclude.length === 0) return { include: 0, exclude: 0, active: false };

  const color = (index: number): string => COLORS[index % COLORS.length];
  const includeStyle = ruleSet.include
    .map((selector, index) => {
      try {
        document.querySelector(selector);
      } catch {
        return '';
      }
      return `${selector} { outline: 2px solid ${color(index)} !important; outline-offset: 1px !important; }`;
    })
    .filter(Boolean)
    .join('\n');
  const excludeStyle = ruleSet.exclude.length > 0
    ? `\n${ruleSet.exclude.join(',\n')} { outline: 2px dashed ${color(ruleSet.include.length)} !important; }`
    : '';

  const style = document.createElement('style');
  style.id = PREVIEW_STYLE_ID;
  style.textContent = includeStyle + excludeStyle;
  document.head.append(style);
  window.setTimeout(() => document.getElementById(PREVIEW_STYLE_ID)?.remove(), PREVIEW_TTL_MS);

  const count = (selectors: readonly string[]): number => {
    let total = 0;
    for (const selector of selectors) {
      try {
        total += document.querySelectorAll(selector).length;
      } catch {
        // 坏选择器：跳过
      }
    }
    return total;
  };
  return { include: count(ruleSet.include), exclude: count(ruleSet.exclude), active: true };
};

/** 页面控制台触发：console.log 高亮与命中数（供用户粘贴反馈）。 */
export const previewSiteRules = async (): Promise<void> => {
  const { getConfig } = await import('../../utils/config');
  const { loadRuleCache } = await import('../../utils/ruleRepository');
  const { compileRuleSet } = await import('../../utils/siteRules');
  const [config, cache] = await Promise.all([getConfig(), loadRuleCache()]);
  const result = preview(compileRuleSet([...cache.rules, ...config.siteRules], location.hostname));
  if (!result.active) {
    console.info('[墨译] 当前站点没有生效的站点规则（先在设置 → 站点规则里添加）。');
    return;
  }
  console.info(
    '[墨译] 站点规则预览：include 命中 ' + result.include + ' 个元素'
    + (result.exclude > 0 ? '，exclude 命中 ' + result.exclude + ' 个（虚线框）' : '')
    + '。高亮 5 秒后自动消失。',
  );
};

/** 供测试/内部复用：纯求值（无样式副作用）。 */
export const countRuleMatches = (ruleSet: CompiledRuleSet): PreviewResult => {
  const count = (selectors: readonly string[]): number => {
    let total = 0;
    for (const selector of selectors) {
      try {
        total += document.querySelectorAll(selector).length;
      } catch {
        // 坏选择器：跳过
      }
    }
    return total;
  };
  return { include: count(ruleSet.include), exclude: count(ruleSet.exclude), active: ruleSet.include.length > 0 || ruleSet.exclude.length > 0 };
};
