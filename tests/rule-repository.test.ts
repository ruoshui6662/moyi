import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RULE_REPO_MAX_BYTES,
  RULE_CACHE_MAX_AGE_MS,
  fetchRuleRepository,
  isRuleCacheFresh,
  parseRuleRepository,
  type RuleCache,
} from '../chrome-plugin/src/utils/ruleRepository';

describe('parseRuleRepository', () => {
  const rawRule = { name: '救回正文', hostPattern: 'Example.COM', includeSelectors: ['.notranslate p'], excludeSelectors: ['.ad'], forceInclude: true };

  it('接受裸数组与 { rules: [] } 两种形态', () => {
    expect(parseRuleRepository(JSON.stringify([rawRule]))).toHaveLength(1);
    expect(parseRuleRepository(JSON.stringify({ rules: [rawRule] }))).toHaveLength(1);
  });

  it('本地重铸 id/source：不让远端伪造个人规则层级', () => {
    const [rule] = parseRuleRepository(JSON.stringify([{ ...rawRule, id: 'personal-fake', source: 'personal' }]));
    expect(rule?.source).toBe('subscribed');
    expect(rule?.id.startsWith('sub-')).toBe(true);
    expect(rule?.id).not.toBe('personal-fake');
  });

  it('host 与选择器清洗照常生效（大小写归一、坏选择器丢弃）', () => {
    const [rule] = parseRuleRepository(JSON.stringify([{ ...rawRule, includeSelectors: ['p', '::::bad::::'] }]));
    expect(rule?.hostPattern).toBe('example.com');
    expect(rule?.includeSelectors).toEqual(['p']);
  });

  it('坏 JSON / 非规则结构 / 空数组均返回空（订阅是增强项，不阻断主链路）', () => {
    expect(parseRuleRepository('{not json')).toEqual([]);
    expect(parseRuleRepository(JSON.stringify({ nope: 1 }))).toEqual([]);
    expect(parseRuleRepository('[]')).toEqual([]);
    expect(parseRuleRepository(JSON.stringify([null, 42, { name: '', hostPattern: 'a.com' }]))).toEqual([]);
  });
});

describe('fetchRuleRepository（mock fetch）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('拉取并解析成功', async () => {
    const payload = JSON.stringify([{ name: 'r', hostPattern: 'a.com', includeSelectors: ['p'] }]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(payload, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const rules = await fetchRuleRepository('https://rules.example.com/site-rules.json');
    expect(rules).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith('https://rules.example.com/site-rules.json', expect.objectContaining({ headers: { Accept: 'application/json' } }));
  });

  it('拒绝非 http(s) 地址（页面可诱导 javascript: 伪协议）', async () => {
    await expect(fetchRuleRepository('javascript:alert(1)')).rejects.toThrow(/http/);
    await expect(fetchRuleRepository('file:///etc/passwd')).rejects.toThrow(/http/);
  });

  it('非 2xx 给可读错误（404/500）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    await expect(fetchRuleRepository('https://a.dev/r.json')).rejects.toThrow(/404/);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));
    await expect(fetchRuleRepository('https://a.dev/r.json')).rejects.toThrow(/500/);
  });

  it('体积超限被拒：content-length 声明与实际体积两路都拦', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', {
      status: 200,
      headers: { 'content-length': String(RULE_REPO_MAX_BYTES + 1) },
    })));
    await expect(fetchRuleRepository('https://a.dev/r.json')).rejects.toThrow(/过大/);
    const big = '[' + ' '.repeat(RULE_REPO_MAX_BYTES + 10) + ']';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(big, { status: 200 })));
    await expect(fetchRuleRepository('https://a.dev/r.json')).rejects.toThrow(/过大/);
  });

  it('网络异常转可读错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));
    await expect(fetchRuleRepository('https://a.dev/r.json')).rejects.toThrow('network down');
  });
});

describe('isRuleCacheFresh', () => {
  const cache = (fetchedAt: number): RuleCache => ({ rules: [], fetchedAt });

  it('24h 内为新鲜，过期/从未拉取为陈旧', () => {
    const now = Date.now();
    expect(isRuleCacheFresh(cache(now - 1000), now)).toBe(true);
    expect(isRuleCacheFresh(cache(now - RULE_CACHE_MAX_AGE_MS - 1), now)).toBe(false);
    expect(isRuleCacheFresh(cache(0), now)).toBe(false);
  });
});
