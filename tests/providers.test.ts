import { describe, expect, it } from 'vitest';

import {
  activateConfiguredProvider,
  ALL_PROVIDER_IDS,
  BUILT_IN_PROVIDERS,
  createCustomProviderId,
  CUSTOM_PROVIDER_ID,
  CUSTOM_PROVIDER_ID_PREFIX,
  CUSTOM_PROVIDER_NAME_MAX_LENGTH,
  getConfiguredProviderIds,
  getCustomProviderIds,
  getProviderDisplayName,
  getProviderMark,
  getProviderMeta,
  getRegisteredProviderIds,
  isDeeplProviderId,
  isMtProviderId,
  isNoKeyMtProviderId,
  isProviderConfigured,
  parseModelsPayload,
  resolveProviderSettings,
  sanitizeProviderId,
  sanitizeProviders,
} from '../chrome-plugin/src/utils/providers';
import { DEFAULT_CONFIG, getConfig, saveConfig } from '../chrome-plugin/src/utils/config';

describe('provider registry', () => {
  it('ships the nine built-in providers', () => {
    expect(BUILT_IN_PROVIDERS.map((provider) => provider.id)).toEqual([
      'openai',
      'deepseek',
      'kimi',
      'minimax',
      'glm',
      'deepl',
      'google',
      'microsoft',
      'tencent',
    ]);
    expect(BUILT_IN_PROVIDERS.map((provider) => provider.label)).toEqual([
      'OpenAI',
      'DeepSeek',
      'Kimi',
      'MiniMax',
      '智谱 GLM',
      'DeepL',
      '谷歌翻译',
      '微软翻译',
      '腾讯翻译',
    ]);
  });

  it('every built-in has an https endpoint, brand color, mark', () => {
    for (const provider of BUILT_IN_PROVIDERS) {
      expect(provider.endpoint.startsWith('https://')).toBe(true);
      expect(provider.color).toMatch(/^#[0-9a-f]{3,8}$/i);
      expect(provider.mark.length).toBeGreaterThan(0);
    }
  });

  it('openai-style built-ins carry fallback models; mt providers are traditional apis', () => {
    for (const provider of BUILT_IN_PROVIDERS.filter((p) => p.kind !== 'mt')) {
      expect(provider.fallbackModels.length).toBeGreaterThan(0);
      expect(provider.svgPath, provider.id).toBeTruthy();
      expect(provider.svgPath?.startsWith('M')).toBe(true);
    }
    const deepl = BUILT_IN_PROVIDERS.find((p) => p.id === 'deepl');
    expect(deepl?.kind).toBe('mt');
    expect(deepl?.endpoint).toBe('https://api-free.deepl.com/v2');
    expect(deepl?.logoSvg).toContain('<svg');
    const tencent = BUILT_IN_PROVIDERS.find((p) => p.id === 'tencent');
    expect(tencent?.kind).toBe('mt');
    expect(tencent?.endpoint).toBe('https://tmt.tencentcloudapi.com');
    expect(tencent?.fallbackModels).toEqual([]);
    expect(tencent?.svgPath?.startsWith('M'), 'tencent carries a vector brand path').toBe(true);
    const microsoft = BUILT_IN_PROVIDERS.find((p) => p.id === 'microsoft');
    expect(microsoft?.kind).toBe('mt');
    expect(microsoft?.endpoint).toBe('https://edge.microsoft.com/translate/translatetext');
    expect(microsoft?.fallbackModels).toEqual([]);
    expect(microsoft?.logoSvg, 'microsoft carries an inline brand svg').toContain('<svg');
    const google = BUILT_IN_PROVIDERS.find((p) => p.id === 'google');
    expect(google?.kind).toBe('mt');
    expect(google?.endpoint).toBe('https://translate-pa.googleapis.com/v1/translateHtml');
    expect(google?.fallbackModels).toEqual([]);
    expect(google?.logoSvg, 'google carries an inline brand svg').toContain('<svg');
  });

  it('identifies mt providers by kind and deepl by id', () => {
    expect(isDeeplProviderId('deepl')).toBe(true);
    expect(isDeeplProviderId('tencent')).toBe(false);
    expect(isDeeplProviderId('openai')).toBe(false);
    expect(isMtProviderId('deepl')).toBe(true);
    expect(isMtProviderId('tencent')).toBe(true);
    expect(isMtProviderId('openai')).toBe(false);
    expect(isMtProviderId('nope')).toBe(false);
    expect(getProviderMeta('deepl').kind).toBe('mt');
    expect(getProviderMeta('tencent').kind).toBe('mt');
  });

  it('unknown ids fall back to custom meta', () => {
    expect(getProviderMeta(CUSTOM_PROVIDER_ID).label).toBe('自定义服务商');
    expect(getProviderMeta('nope').id).toBe(CUSTOM_PROVIDER_ID);
    expect(sanitizeProviderId('kimi')).toBe('kimi');
    expect(sanitizeProviderId('nope')).toBe('openai');
    expect(sanitizeProviderId(undefined)).toBe('openai');
  });

  it('sanitizeProviderId accepts registered custom ids from the provider table', () => {
    const providers = {
      'custom-abc': { apiKey: 'k', endpoint: 'https://x/v1', model: 'm' },
      [CUSTOM_PROVIDER_ID]: { apiKey: 'k', endpoint: 'https://x/v1', model: 'm' },
    };
    expect(sanitizeProviderId('custom-abc', providers)).toBe('custom-abc');
    expect(sanitizeProviderId(CUSTOM_PROVIDER_ID, providers)).toBe(CUSTOM_PROVIDER_ID);
    // 未注册的新 id 无凭据上下文时回退
    expect(sanitizeProviderId('custom-xyz')).toBe('openai');
    expect(sanitizeProviderId('custom-xyz', providers)).toBe('openai');
  });

  it('creates unique prefixed custom provider ids', () => {
    const first = createCustomProviderId();
    const second = createCustomProviderId();
    expect(first.startsWith(CUSTOM_PROVIDER_ID_PREFIX)).toBe(true);
    expect(first).not.toBe(second);
  });
});

describe('provider sanitizers and resolution', () => {
  it('sanitizeProviders keeps known ids and any registered custom ids', () => {
    const cleaned = sanitizeProviders({
      openai: { apiKey: 'sk-1', endpoint: ' https://x ', model: ' gpt ' },
      'custom-relay': { apiKey: 'sk-r', endpoint: 'https://relay.test/v1', model: 'relay-model' },
      deepseek: 'not-an-object',
      glm: null,
    });
    expect(Object.keys(cleaned).sort()).toEqual(['custom-relay', 'openai']);
    expect(cleaned.openai).toEqual({ apiKey: 'sk-1', endpoint: 'https://x', model: 'gpt' });
    expect(cleaned['custom-relay']).toEqual({ apiKey: 'sk-r', endpoint: 'https://relay.test/v1', model: 'relay-model' });
    expect(sanitizeProviders(null)).toEqual({});
    expect(sanitizeProviders('x')).toEqual({});
  });

  it('enumerates custom provider ids and registered ids dynamically', () => {
    const providers = {
      'custom-1': { apiKey: 'a' },
      'custom-2': { apiKey: 'b', endpoint: 'https://y/v1', model: 'm' },
      openai: { apiKey: 'o' },
    };
    expect(getCustomProviderIds(providers)).toEqual(['custom-1', 'custom-2']);
    expect(getRegisteredProviderIds(providers)).toEqual([
      ...ALL_PROVIDER_IDS,
      'custom-1',
      'custom-2',
    ]);
    expect(getCustomProviderIds(undefined)).toEqual([]);
  });

  it('sanitizes and truncates custom provider names; blank names are dropped', () => {
    const cleaned = sanitizeProviders({
      custom: { apiKey: 'k', endpoint: 'https://custom/v1', model: 'm', name: '  我的代理  ' },
    });
    expect(cleaned.custom?.name).toBe('我的代理');

    const overLong = sanitizeProviders({
      custom: { apiKey: 'k', endpoint: 'https://custom/v1', model: 'm', name: '超'.repeat(60) },
    });
    expect(overLong.custom?.name?.length).toBe(CUSTOM_PROVIDER_NAME_MAX_LENGTH);

    const blank = sanitizeProviders({
      custom: { apiKey: 'k', endpoint: 'https://custom/v1', model: 'm', name: '   ' },
    });
    expect(blank.custom?.name).toBeUndefined();
  });

  it('sanitizes and keeps tencent apiSecret/region while rejecting junk regions', () => {
    const cleaned = sanitizeProviders({
      tencent: { apiKey: 'sid', apiSecret: 'skey', region: 'ap-shanghai' },
    });
    expect(cleaned.tencent?.apiSecret).toBe('skey');
    expect(cleaned.tencent?.region).toBe('ap-shanghai');
    expect(cleaned.tencent?.apiKey).toBe('sid');

    const junk = sanitizeProviders({
      tencent: { apiKey: 'sid', apiSecret: 'skey', region: '<script>region</script>' },
    });
    expect(junk.tencent?.apiSecret).toBe('skey');
    expect(junk.tencent?.region).toBeUndefined();
  });

  it('strips HTML-dangerous characters from custom provider names', () => {
    const cleaned = sanitizeProviders({
      custom: {
        apiKey: 'k',
        endpoint: 'https://custom/v1',
        model: 'm',
        name: '<script>代理</script>',
      },
    });
    expect(cleaned.custom?.name).toContain('代理');
    expect(cleaned.custom?.name).not.toMatch(/[<>"'`=]/);
  });

  it('uses custom display name and mark, falling back to defaults without a name', () => {
    const named = { custom: { apiKey: 'k', endpoint: 'https://custom/v1', model: 'm', name: '中继网关' } };
    expect(getProviderDisplayName(named, CUSTOM_PROVIDER_ID)).toBe('中继网关');
    expect(getProviderMark(named, CUSTOM_PROVIDER_ID)).toBe('中');

    const unnamed = { custom: { apiKey: 'k', endpoint: 'https://custom/v1', model: 'm' } };
    expect(getProviderDisplayName(unnamed, CUSTOM_PROVIDER_ID)).toBe('自定义服务商');
    expect(getProviderMark(unnamed, CUSTOM_PROVIDER_ID)).toBe('自');

    expect(getProviderDisplayName(undefined, 'deepseek')).toBe('DeepSeek');
    expect(getProviderMark(undefined, 'deepseek')).toBe('D');
  });

  it('resolveProviderSettings applies built-in defaults and lets stored values win', () => {
    const defaults = resolveProviderSettings({ providers: {} }, 'deepseek');
    expect(defaults.endpoint).toBe('https://api.deepseek.com');
    expect(defaults.apiKey).toBe('');
    expect(defaults.apiSecret).toBe('');
    expect(defaults.model).toBe('');
    expect(defaults.region).toBe('');

    const stored = resolveProviderSettings(
      { providers: { deepseek: { apiKey: 'sk-d', model: 'deepseek-chat' } } },
      'deepseek',
    );
    expect(stored).toEqual({ apiKey: 'sk-d', apiSecret: '', endpoint: 'https://api.deepseek.com', model: 'deepseek-chat', region: '' });

    const custom = resolveProviderSettings({ providers: {} }, CUSTOM_PROVIDER_ID);
    expect(custom.endpoint).toBe('');
  });

  it('tencent resolves default region and merges stored apiSecret/region', () => {
    const defaults = resolveProviderSettings({ providers: {} }, 'tencent');
    expect(defaults.endpoint).toBe('https://tmt.tencentcloudapi.com');
    expect(defaults.apiSecret).toBe('');
    expect(defaults.region).toBe('ap-guangzhou');

    const stored = resolveProviderSettings(
      { providers: { tencent: { apiKey: 'sid', apiSecret: 'skey', region: 'ap-shanghai' } } },
      'tencent',
    );
    expect(stored).toEqual({ apiKey: 'sid', apiSecret: 'skey', endpoint: 'https://tmt.tencentcloudapi.com', model: '', region: 'ap-shanghai' });
  });

  it('isProviderConfigured requires all three fields for openai-style providers', () => {
    expect(isProviderConfigured({ apiKey: 'k', apiSecret: '', endpoint: 'https://x', model: 'm' }, 'openai')).toBe(true);
    expect(isProviderConfigured({ apiKey: '', apiSecret: '', endpoint: 'https://x', model: 'm' }, 'openai')).toBe(false);
    expect(isProviderConfigured({ apiKey: 'k', apiSecret: '', endpoint: '', model: 'm' }, 'openai')).toBe(false);
    expect(isProviderConfigured({ apiKey: 'k', apiSecret: '', endpoint: 'https://x', model: '' }, 'openai')).toBe(false);
  });

  it('isProviderConfigured accepts deepl with only api key and endpoint', () => {
    expect(isProviderConfigured({ apiKey: 'd', apiSecret: '', endpoint: 'https://api-free.deepl.com/v2', model: '' }, 'deepl')).toBe(true);
    expect(isProviderConfigured({ apiKey: '', apiSecret: '', endpoint: 'https://api-free.deepl.com/v2', model: '' }, 'deepl')).toBe(false);
    expect(isProviderConfigured({ apiKey: 'd', apiSecret: '', endpoint: '', model: '' }, 'deepl')).toBe(false);
  });

  it('isProviderConfigured requires SecretKey and endpoint for tencent', () => {
    expect(isProviderConfigured({ apiKey: 'sid', apiSecret: 'skey', endpoint: 'https://tmt.tencentcloudapi.com', model: '' }, 'tencent')).toBe(true);
    expect(isProviderConfigured({ apiKey: 'sid', apiSecret: '', endpoint: 'https://tmt.tencentcloudapi.com', model: '' }, 'tencent')).toBe(false);
    expect(isProviderConfigured({ apiKey: 'sid', apiSecret: 'skey', endpoint: '', model: '' }, 'tencent')).toBe(false);
  });

  it('isProviderConfigured treats microsoft as always configured (no credentials)', () => {
    expect(isProviderConfigured({ apiKey: '', apiSecret: '', endpoint: '', model: '' }, 'microsoft')).toBe(true);
    expect(isMtProviderId('microsoft')).toBe(true);
  });

  it('isProviderConfigured treats google as always configured (no credentials)', () => {
    expect(isProviderConfigured({ apiKey: '', apiSecret: '', endpoint: '', model: '' }, 'google')).toBe(true);
    expect(isMtProviderId('google')).toBe(true);
    expect(isNoKeyMtProviderId('google')).toBe(true);
    expect(isNoKeyMtProviderId('microsoft')).toBe(true);
    expect(isNoKeyMtProviderId('deepl')).toBe(false);
  });

  it('activates a microsoft provider without any credentials', () => {
    const config = { ...DEFAULT_CONFIG, providers: {} };
    const activated = activateConfiguredProvider(config, 'microsoft');
    expect(activated.providerId).toBe('microsoft');
    expect(activated.endpoint).toBe('https://edge.microsoft.com/translate/translatetext');
    expect(activated.apiKey).toBe('');
  });

  it('activates a deepl provider without requiring a model', () => {
    const config = {
      ...DEFAULT_CONFIG,
      providers: { deepl: { apiKey: 'd-key', endpoint: 'https://api.deepl.com/v2' } },
    };
    const activated = activateConfiguredProvider(config, 'deepl');
    expect(activated.providerId).toBe('deepl');
    expect(activated.endpoint).toBe('https://api.deepl.com/v2');
  });

  it('activates a tencent provider with SecretKey and default region', () => {
    const config = {
      ...DEFAULT_CONFIG,
      providers: { tencent: { apiKey: 'sid', apiSecret: 'skey' } },
    };
    const activated = activateConfiguredProvider(config, 'tencent');
    expect(activated.providerId).toBe('tencent');
    expect(activated.endpoint).toBe('https://tmt.tencentcloudapi.com');
    expect(activated.model).toBe('');
  });

  it('lists only fully configured providers and applies built-in endpoints', () => {
    expect(getConfiguredProviderIds({
      providers: {
        openai: { apiKey: 'sk-o', model: 'gpt-4o-mini' },
        deepseek: { apiKey: 'sk-d' },
        custom: { apiKey: 'sk-c', endpoint: 'https://custom.test/v1', model: 'custom-model' },
      },
    })).toEqual(['openai', 'google', 'microsoft', 'custom']);
    // 免密钥服务商（谷歌/微软翻译）无需凭据即始终可用，顺序跟随内置列表
    expect(getConfiguredProviderIds({ providers: {} })).toEqual(['google', 'microsoft']);
  });

  it('lists multiple configured custom providers alongside built-ins', () => {
    const configured = getConfiguredProviderIds({
      providers: {
        openai: { apiKey: 'sk-o', model: 'gpt-4o-mini' },
        'custom-a': { apiKey: 'a', endpoint: 'https://a.test/v1', model: 'm-a' },
        'custom-b': { apiKey: 'b', endpoint: 'https://b.test/v1', model: 'm-b' },
        'custom-incomplete': { apiKey: 'x' },
      },
    });
    expect(configured).toContain('openai');
    expect(configured).toContain('custom-a');
    expect(configured).toContain('custom-b');
    expect(configured).not.toContain('custom-incomplete');
  });

  it('activates a custom provider by id regardless of its generated suffix', () => {
    const id = 'custom-node-9x';
    const config = {
      ...DEFAULT_CONFIG,
      providers: {
        ...DEFAULT_CONFIG.providers,
        [id]: { apiKey: 'sk-n', endpoint: 'https://node.test/v1', model: 'node-model', name: '节点代理' },
      },
    };
    const activated = activateConfiguredProvider(config, id);
    expect(activated.providerId).toBe(id);
    expect(activated.apiKey).toBe('sk-n');
    expect(activated.endpoint).toBe('https://node.test/v1');
    expect(activated.model).toBe('node-model');
    expect(getProviderDisplayName(config.providers, id)).toBe('节点代理');
    expect(getProviderMark(config.providers, id)).toBe('节');
  });

  it('activates a configured provider by synchronizing all runtime fields', () => {
    const config = {
      ...DEFAULT_CONFIG,
      targetLanguage: 'English',
      providers: {
        ...DEFAULT_CONFIG.providers,
        deepseek: { apiKey: 'sk-d', model: 'deepseek-chat' },
      },
    };
    const activated = activateConfiguredProvider(config, 'deepseek');

    expect(activated.providerId).toBe('deepseek');
    expect(activated.apiKey).toBe('sk-d');
    expect(activated.endpoint).toBe('https://api.deepseek.com');
    expect(activated.model).toBe('deepseek-chat');
    expect(activated.targetLanguage).toBe('English');
    expect(activated.providers).toBe(config.providers);
  });

  it('rejects unknown and incompletely configured providers', () => {
    const config = {
      ...DEFAULT_CONFIG,
      providers: { deepseek: { apiKey: 'sk-d' } },
    };
    expect(() => activateConfiguredProvider(config, 'nope')).toThrow('未知的翻译服务');
    expect(() => activateConfiguredProvider(config, 'deepseek')).toThrow('尚未完整配置');
  });
});

describe('parseModelsPayload tolerance', () => {
  it('parses the standard OpenAI shape {data:[{id}]}', () => {
    expect(parseModelsPayload({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] })).toEqual([
      'gpt-4o',
      'gpt-4o-mini',
    ]);
  });

  it('parses {models:[...]} and root-array variants', () => {
    expect(parseModelsPayload({ models: [{ id: 'm1' }, { model: 'm2' }, { name: 'm3' }] })).toEqual(['m1', 'm2', 'm3']);
    expect(parseModelsPayload(['a', 'b'])).toEqual(['a', 'b']);
    expect(parseModelsPayload([{ id: 'x' }, 'y'])).toEqual(['x', 'y']);
  });

  it('returns empty list for junk payloads without throwing', () => {
    expect(parseModelsPayload(null)).toEqual([]);
    expect(parseModelsPayload('nope')).toEqual([]);
    expect(parseModelsPayload({})).toEqual([]);
    expect(parseModelsPayload({ data: [{}, { id: '' }, 42] })).toEqual([]);
  });
});

describe('config integration', () => {
  const backing: Record<string, unknown> = {};
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        get: async (key: string) => (key in backing ? { [key]: backing[key] } : {}),
        set: async (obj: Record<string, unknown>) => {
          Object.assign(backing, obj);
        },
      },
    },
  };

  it('defaults carry an empty provider table with openai active', () => {
    expect(DEFAULT_CONFIG.providerId).toBe('openai');
    expect(DEFAULT_CONFIG.providers).toEqual({});
  });

  it('migrates legacy top-level credentials into the custom provider', async () => {
    delete backing['personal-translator-config'];
    backing['personal-translator-config'] = {
      endpoint: 'https://api.deepseek.com',
      apiKey: 'legacy-key',
      model: 'deepseek-chat',
    };
    const config = await getConfig();
    expect(config.providerId).toBe(CUSTOM_PROVIDER_ID);
    expect(config.providers[CUSTOM_PROVIDER_ID]).toEqual({
      apiKey: 'legacy-key',
      endpoint: 'https://api.deepseek.com',
      model: 'deepseek-chat',
    });
    // 迁移后顶层字段由自定义服务商派生
    expect(config.apiKey).toBe('legacy-key');
    expect(config.endpoint).toBe('https://api.deepseek.com');
    expect(config.model).toBe('deepseek-chat');
  });

  it('does not persist a second top-level copy of the key', async () => {
    delete backing['personal-translator-config'];
    const config = await getConfig();
    const next = {
      ...config,
      providerId: 'glm',
      providers: {
        glm: { apiKey: 'g1', endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
      },
      apiKey: 'stale-top-level',
      endpoint: 'https://stale.example/v1',
      model: 'stale-model',
    };
    await saveConfig(next);

    const stored = backing['personal-translator-config'] as Record<string, unknown>;
    expect(stored).not.toHaveProperty('apiKey');
    expect(stored).not.toHaveProperty('endpoint');
    expect(stored).not.toHaveProperty('model');
    expect((stored.providers as Record<string, { apiKey: string }>).glm.apiKey).toBe('g1');
  });

  it('derives top-level credentials from the active provider on read', async () => {
    delete backing['personal-translator-config'];
    const config = await getConfig();
    await saveConfig({
      ...config,
      providerId: 'glm',
      providers: {
        glm: { apiKey: 'g1', endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
      },
    });

    const verified = await getConfig();
    expect(verified.apiKey).toBe('g1');
    expect(verified.endpoint).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(verified.model).toBe('glm-4-flash');

    // 切换激活服务商后，顶层字段随之派生；未配置的内置服务商回到空 Key + 官方地址
    await saveConfig({ ...verified, providerId: 'openai' });
    const afterSwitch = await getConfig();
    expect(afterSwitch.apiKey).toBe('');
    expect(afterSwitch.endpoint).toBe('https://api.openai.com/v1');
  });

  it('round-trips provider tables without migration side effects', async () => {
    const config = await getConfig();
    const next = {
      ...config,
      providerId: 'glm',
      providers: { ...config.providers, glm: { apiKey: 'g1', model: 'glm-4-flash' } },
      apiKey: 'g1',
      endpoint: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4-flash',
    };
    await saveConfig(next);
    const verified = await getConfig();
    expect(verified.providerId).toBe('glm');
    expect(verified.providers.glm?.model).toBe('glm-4-flash');
    expect(verified.endpoint).toBe('https://open.bigmodel.cn/api/paas/v4');
  });
});
