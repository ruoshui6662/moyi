/**
 * 规则仓库（订阅源）：解析、拉取与本地缓存。
 *
 * 网络只走 background（内容脚本/设置页的 fetch 受页面 CORS 管辖，MV3 的
 * `<all_urls>` 只让扩展侧免 CORS）——本模块的 fetch 由 background 处理器调用。
 *
 * 不可信输入三道闸：① 2MB 体积上限（防仓库撑爆内存/存储）② JSON 解析容错
 * ③ 每条规则过 sanitizeSiteRules（选择器预校验、条数/长度上限）。失败一律
 * 返回可读错误，缓存保持旧值——订阅是增强项，永不阻断翻译主链路。
 */

import { sanitizeSiteRules, type SiteRule } from './siteRules';

export const RULE_REPO_MAX_BYTES = 2_000_000;
export const RULE_REPO_TIMEOUT_MS = 15_000;
export const RULE_CACHE_STORAGE_KEY = 'moyi-site-rule-cache';
/** 缓存新鲜期：超期可在设置页手动刷新（v1 不做后台自动拉取，避免每次翻译都打网络）。 */
export const RULE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface RuleCache {
  /** 只读暴露：缓存对象可能被多处持有（设置页/内容脚本），不该被下游就地改写。 */
  rules: readonly SiteRule[];
  fetchedAt: number;
}

const isHttpUrl = (url: string): boolean => /^https?:\/\//i.test(url.trim());

/**
 * 解析仓库 JSON：接受裸数组或 `{ "rules": [...] }`；每条补 id 与 source='subscribed'
 * （仓库里的 id/source 一律以本地生成为准——不让远端伪造个人规则层级）。
 */
export const parseRuleRepository = (text: string): SiteRule[] => {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { rules?: unknown }).rules)
      ? (payload as { rules: unknown[] }).rules
      : null;
  if (!list) return [];
  const withMeta = list.map((raw, index) => {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    return {
      ...item,
      id: `sub-${index}-${typeof item.hostPattern === 'string' ? item.hostPattern : ''}`,
      source: 'subscribed',
      enabled: item.enabled !== false,
    };
  });
  return sanitizeSiteRules(withMeta);
};

/** 拉取单个仓库；非 2xx / 体积超限 / 超时都转成可读错误。 */
export const fetchRuleRepository = async (url: string): Promise<SiteRule[]> => {
  const target = url.trim();
  if (!isHttpUrl(target)) throw new Error('仓库地址必须以 http:// 或 https:// 开头。');
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), RULE_REPO_TIMEOUT_MS);
  try {
    const response = await fetch(target, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`仓库拉取失败（HTTP ${response.status}）。`);
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > RULE_REPO_MAX_BYTES) {
      throw new Error(`规则仓库过大（${Math.round(declared / 1024)} KB，上限 ${RULE_REPO_MAX_BYTES / 1024} KB）。`);
    }
    const text = await response.text();
    if (text.length > RULE_REPO_MAX_BYTES) throw new Error('规则仓库过大，超过 2 MB 上限。');
    return parseRuleRepository(text);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('规则仓库拉取超时（15 秒）。');
    }
    throw error instanceof Error ? error : new Error('规则仓库拉取失败。');
  } finally {
    globalThis.clearTimeout(timer);
  }
};

export const loadRuleCache = async (): Promise<RuleCache> => {
  try {
    const stored = await chrome.storage.local.get(RULE_CACHE_STORAGE_KEY);
    const value = stored[RULE_CACHE_STORAGE_KEY] as Partial<RuleCache> | undefined;
    return {
      rules: sanitizeSiteRules(value?.rules),
      fetchedAt: typeof value?.fetchedAt === 'number' && Number.isFinite(value.fetchedAt) ? value.fetchedAt : 0,
    };
  } catch {
    return { rules: [], fetchedAt: 0 };
  }
};

export const saveRuleCache = async (cache: RuleCache): Promise<void> => {
  await chrome.storage.local.set({
    [RULE_CACHE_STORAGE_KEY]: { rules: sanitizeSiteRules(cache.rules), fetchedAt: cache.fetchedAt },
  });
};

export const isRuleCacheFresh = (cache: RuleCache, now = Date.now()): boolean =>
  cache.fetchedAt > 0 && now - cache.fetchedAt < RULE_CACHE_MAX_AGE_MS;
