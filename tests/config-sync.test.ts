import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIG_BACKUP_VERSION,
  CONFIG_HISTORY_MAX,
  DEFAULT_WEBDAV,
  PROFILES_MAX,
  applyProfile,
  buildConfigBackup,
  buildProfileSnapshot,
  mergeSnapshot,
  mergeSubscriptionResults,
  nextProfilesOnSave,
  parseConfigBackup,
  pushConfigHistory,
  sanitizeConfigHistory,
  sanitizeProfiles,
  sanitizeWebDavSettings,
  serializeConfigBackup,
  stripSecrets,
  webDavGet,
  webDavProbe,
  webDavPut,
  webDavTargetUrl,
  type SceneProfile,
} from '../chrome-plugin/src/utils/configSync';
import { DEFAULT_CONFIG, type TranslatorConfig } from '../chrome-plugin/src/utils/config';
import { sanitizeSiteRules } from '../chrome-plugin/src/utils/siteRules';

const withKey = (): TranslatorConfig => ({
  ...DEFAULT_CONFIG,
  apiKey: 'sk-real-secret',
  endpoint: 'https://api.example.com/v1',
  model: 'gpt-x',
  providers: {
    openai: { apiKey: 'sk-real-secret', endpoint: 'https://api.example.com/v1', model: 'gpt-x' },
    custom: { apiKey: 'sk-second-secret', apiSecret: 'tencent-secret', endpoint: 'https://x/v1', model: 'm' },
  },
});

describe('密钥纪律：备份/历史/Profile 一律无凭据', () => {
  it('stripSecrets 清空顶层与各服务商的 apiKey/apiSecret，保留端点/模型', () => {
    const stripped = stripSecrets(withKey());
    expect(stripped.apiKey).toBe('');
    const providers = stripped.providers as Record<string, { apiKey?: string; apiSecret?: string; endpoint?: string }>;
    expect(providers.openai.apiKey ?? '').toBe('');
    expect(providers.custom.apiKey ?? '').toBe('');
    expect(providers.custom.apiSecret ?? '').toBe('');
    expect(providers.openai.endpoint).toBe('https://api.example.com/v1');
  });

  it('序列化后的备份文本里搜不到任何真实 Key', () => {
    const json = serializeConfigBackup(withKey());
    expect(json).not.toContain('sk-real-secret');
    expect(json).not.toContain('sk-second-secret');
    expect(json).not.toContain('tencent-secret');
    const backup = buildConfigBackup(withKey());
    expect(backup.schemaVersion).toBe(CONFIG_BACKUP_VERSION);
    expect(backup.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('mergeSnapshot 恢复非敏感字段、凭据保持当前值', () => {
    const current = withKey();
    const restored = mergeSnapshot(current, { translationStyle: 'jade-line', apiKey: 'attacker-injected' });
    expect(restored.translationStyle).toBe('jade-line');
    expect(restored.apiKey).toBe('sk-real-secret');
  });

  it('历史快照不含凭据且按上限滚动', () => {
    let history = pushConfigHistory([], withKey(), '第一次');
    expect((history[0].snapshot.providers as Record<string, { apiKey?: string }>).openai.apiKey ?? '').toBe('');
    for (let i = 1; i < CONFIG_HISTORY_MAX + 3; i += 1) {
      history = pushConfigHistory(history, withKey(), `第${i}次`);
    }
    expect(history).toHaveLength(CONFIG_HISTORY_MAX);
    expect(history[0].label).toBe(`第${CONFIG_HISTORY_MAX + 2}次`);
  });
});

describe('parseConfigBackup 容错', () => {
  it('合法备份原样取出快照与导出时间', () => {
    const parsed = parseConfigBackup(serializeConfigBackup(withKey()));
    expect(parsed.error).toBeUndefined();
    expect(parsed.exportedAt).toBeTruthy();
    expect(parsed.snapshot?.translationStyle).toBe(DEFAULT_CONFIG.translationStyle);
  });

  it('坏 JSON / 缺版本 / 版本过新 / 缺 config 都给可读错误', () => {
    expect(parseConfigBackup('{not json').error).toContain('JSON');
    expect(parseConfigBackup('{"config":{}}').error).toContain('schemaVersion');
    expect(parseConfigBackup('{"schemaVersion":999,"config":{}}').error).toContain('升级');
    expect(parseConfigBackup('{"schemaVersion":1}').error).toContain('config');
    expect(parseConfigBackup('[]').error).toBeTruthy();
  });

  it('低版本备份可读（向前兼容）', () => {
    expect(parseConfigBackup('{"schemaVersion":1,"config":{"translationStyle":"plain"}}').snapshot?.translationStyle).toBe('plain');
  });
});

describe('sanitizeWebDavSettings', () => {
  it('只接受 http(s) 地址、剥前导斜杠、缺 path 回默认', () => {
    expect(sanitizeWebDavSettings({ url: 'ftp://x', username: 'u', path: 'a.json' }).url).toBe('');
    expect(sanitizeWebDavSettings({ url: 'https://dav.example.com/dav/', username: ' u ', password: ' p ', path: '/a.json' })).toEqual({
      url: 'https://dav.example.com/dav/', username: 'u', password: 'p', path: 'a.json',
    });
    expect(sanitizeWebDavSettings({ url: 'https://dav.example.com' }).path).toBe(DEFAULT_WEBDAV.path);
    expect(sanitizeWebDavSettings(undefined)).toEqual(DEFAULT_WEBDAV);
  });
});

describe('场景 Profile', () => {
  const profile = (overrides: Partial<SceneProfile> = {}): SceneProfile => ({
    id: 'p1',
    name: '学术精读',
    snapshot: buildProfileSnapshot({ ...DEFAULT_CONFIG, providerId: 'deepseek', promptStyle: 'academic', translationStyle: 'jade-line' }),
    ...overrides,
  });

  it('sanitize 丢弃无名/重 id 并限 PROFILES_MAX 条', () => {
    const many = Array.from({ length: PROFILES_MAX + 5 }, (_, i) => ({ id: `p${i}`, name: `n${i}`, snapshot: {} }));
    expect(sanitizeProfiles([{ id: 'a', name: '' }, { id: 'a', name: 'dup' }, ...many])).toHaveLength(PROFILES_MAX);
  });

  it('applyProfile 覆盖风格类字段、凭据表不动', () => {
    const current = withKey();
    const applied = applyProfile(current, profile());
    expect(applied.providerId).toBe('deepseek');
    expect(applied.promptStyle).toBe('academic');
    expect(applied.translationStyle).toBe('jade-line');
    expect(applied.providers).toBe(current.providers);
    expect(applied.apiKey).toBe('sk-real-secret');
  });
});

describe('WebDAV 客户端（mock fetch）', () => {
  const settings = { url: 'https://dav.example.com/dav/', username: 'user', password: 'p@ss', path: 'moyi.json' };
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('目标 URL 拼接无双斜杠', () => {
    expect(webDavTargetUrl(settings)).toBe('https://dav.example.com/dav/moyi.json');
  });

  it('PUT 带 Basic auth 与 JSON content-type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    await webDavPut(settings, '{"schemaVersion":1}');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://dav.example.com/dav/moyi.json');
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa('user:p@ss')}`);
    expect((init.headers as Record<string, string>)['Content-Type']).toContain('application/json');
    expect(init.body).toBe('{"schemaVersion":1}');
  });

  it('GET 200 返回文本，404 返回 null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('backup-text', { status: 200 })));
    expect(await webDavGet(settings)).toBe('backup-text');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('', { status: 404 })));
    expect(await webDavGet(settings)).toBeNull();
  });

  it('401/403 给出凭据文案，409 给出占用文案', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('', { status: 401 })));
    await expect(webDavGet(settings)).rejects.toThrow(/凭据/);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('', { status: 409 })));
    await expect(webDavPut(settings, '{}')).rejects.toThrow(/占用/);
  });

  it('probe 区分「有备份/无备份」，网络异常转可读错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('x', { status: 200 })));
    expect(await webDavProbe(settings)).toEqual({ reachable: true, hasBackup: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('', { status: 404 })));
    expect(await webDavProbe(settings)).toEqual({ reachable: true, hasBackup: false });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('network down')));
    await expect(webDavProbe(settings)).rejects.toThrow(/WebDAV 请求失败/);
  });
});

describe('sanitizeConfigHistory', () => {
  it('丢弃无快照条目并限长', () => {
    const history = sanitizeConfigHistory([
      { at: 1, label: 'x' },
      ...Array.from({ length: CONFIG_HISTORY_MAX + 3 }, (_, i) => ({ at: i, label: `h${i}`, snapshot: { translationStyle: 'plain' } })),
    ]);
    expect(history).toHaveLength(CONFIG_HISTORY_MAX);
    expect(history.every((entry) => entry.snapshot)).toBe(true);
  });
});

describe('订阅合并决策（W5.2 抽测）', () => {
  it('全部成功：合并规则、可写缓存、success', () => {
    const merge = mergeSubscriptionResults([
      { url: 'https://a.dev/r.json', rules: sanitizeSiteRules([{ name: 'a', hostPattern: 'a.com', includeSelectors: ['p'], forceInclude: true, id: 'x1' }]) },
      { url: 'https://b.dev/r.json', rules: sanitizeSiteRules([{ name: 'b', hostPattern: 'b.com', includeSelectors: ['p'], forceInclude: true, id: 'x2' }]) },
    ]);
    expect(merge.rules).toHaveLength(2);
    expect(merge.failures).toHaveLength(0);
    expect(merge.shouldWriteCache).toBe(true);
    expect(merge.success).toBe(true);
  });

  it('部分失败但拿到规则：写缓存（失败项不影响成功项）', () => {
    const merge = mergeSubscriptionResults([
      { url: 'https://a.dev/r.json', rules: sanitizeSiteRules([{ name: 'a', hostPattern: 'a.com', includeSelectors: ['p'], forceInclude: true, id: 'x1' }]) },
      { url: 'https://b.dev/r.json', error: '404' },
    ]);
    expect(merge.rules).toHaveLength(1);
    expect(merge.failures[0]).toEqual({ url: 'https://b.dev/r.json', error: '404' });
    expect(merge.shouldWriteCache).toBe(true);
    expect(merge.success).toBe(false);
  });

  it('全部失败：不写缓存（保留旧缓存）', () => {
    const merge = mergeSubscriptionResults([
      { url: 'https://a.dev/r.json', error: 'network' },
      { url: 'https://b.dev/r.json' },
    ]);
    expect(merge.rules).toEqual([]);
    expect(merge.shouldWriteCache).toBe(false);
    expect(merge.failures).toHaveLength(2);
  });

  it('全部成功但仓库为空：允许写缓存（等于清空订阅规则）', () => {
    const merge = mergeSubscriptionResults([{ url: 'https://a.dev/r.json', rules: [] }]);
    expect(merge.shouldWriteCache).toBe(true);
    expect(merge.success).toBe(true);
  });
});

describe('场景保存准入（W5.2 抽测）', () => {
  const snapshot = buildProfileSnapshot({ ...DEFAULT_CONFIG, providerId: 'openai' });

  it('空名拒绝；成功时 id 由注入工厂生成', () => {
    expect(nextProfilesOnSave([], '  ', snapshot, () => 'id-1').error).toBe('empty-name');
    const ok = nextProfilesOnSave([], '学术精读', snapshot, () => 'id-1');
    expect(ok.profiles?.[0]).toMatchObject({ id: 'id-1', name: '学术精读' });
  });

  it('达上限拒绝且不修改入参', () => {
    const full = Array.from({ length: PROFILES_MAX }, (_, i) => ({ id: `p${i}`, name: `n${i}`, snapshot }));
    const result = nextProfilesOnSave(full, '新场景', snapshot, () => 'overflow');
    expect(result.error).toBe('cap-reached');
    expect(full).toHaveLength(PROFILES_MAX);
  });
});
