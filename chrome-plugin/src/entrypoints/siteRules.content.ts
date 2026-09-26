/**
 * 站点规则注入入口（插件独有载体，红线 3）：把共享 content/main 广播的
 * 「应用规则」事件落到实际的会话规则集上，并承接控制台试运行命令。
 *
 * 为什么独立成入口：规则模块只服务扩展端；油猴构建的 import 图从 userscript/entry.ts
 * 出发，不触达本文件，规则功能整体不进油猴产物（非压缩产物体积敏感，30KB 不是小数）。
 *
 * 同步性契约：共享层在 translatePage 之前**同步派发**事件，detail 携带个人规则快照；
 * 本监听器同步读取订阅缓存（内存）+ detail → 同步注入。订阅缓存首读是异步的，
 * 首屏若尚未落库，本次翻译只有个人规则生效（订阅对下一次翻译生效）——
 * 这是刻意取舍：不为订阅牺牲首翻的确定性。
 */

import type { SiteRule } from '../utils/siteRules';
import { compileRuleSet, sanitizeSiteRules } from '../utils/siteRules';
import { loadRuleCache, type RuleCache } from '../utils/ruleRepository';
import { APPLY_SITE_RULES_EVENT } from './content/siteRuleBridge';
import { setSessionRuleSet } from './content/trans';
import { PREVIEW_RULES_EVENT, previewSiteRules } from './content/siteRulePreview';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_idle',
  main() {
    let subscribedCache: RuleCache = { rules: [], fetchedAt: 0 };

    const applyRules = (event: Event): void => {
      const personal = sanitizeSiteRules((event as CustomEvent<{ personalRules?: SiteRule[] }>).detail?.personalRules ?? []);
      setSessionRuleSet(compileRuleSet([...subscribedCache.rules, ...personal], location.hostname));
    };

    window.addEventListener(APPLY_SITE_RULES_EVENT, applyRules);
    document.addEventListener(PREVIEW_RULES_EVENT, () => void previewSiteRules());
    void loadRuleCache().then((cache) => {
      subscribedCache = cache;
      // 缓存晚到：补注一次（个人规则从 storage 重读一次即可）
      void chrome.storage.local.get('personal-translator-config').then((stored) => {
        const raw = (stored['personal-translator-config'] ?? {}) as { siteRules?: unknown };
        setSessionRuleSet(compileRuleSet(
          [...cache.rules, ...sanitizeSiteRules(Array.isArray(raw.siteRules) ? raw.siteRules : [])],
          location.hostname,
        ));
      });
    });
  },
});
