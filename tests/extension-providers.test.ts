import { describe, expect, it } from 'vitest';
import {
  describeOllamaAccessError,
  EXTENSION_BUILT_IN_PROVIDERS,
  OLLAMA_API_KEY_SENTINEL,
  OLLAMA_DEFAULT_ENDPOINT,
  OLLAMA_PROVIDER_ID,
  getExtensionConfiguredProviderIds,
  getExtensionCustomProviderIds,
  getExtensionProviderMeta,
  isExtensionProviderConfigured,
  prepareExtensionProviderConfig,
  resolveExtensionProviderSettings,
} from '../chrome-plugin/src/utils/extensionProviders';
import { BUILT_IN_PROVIDERS } from '../chrome-plugin/src/utils/providers';
import { validateEndpointUrl } from '../chrome-plugin/src/service/common';

describe('Ollama extension provider', () => {
  it('is an extension-only built-in OpenAI-compatible provider', () => {
    expect(EXTENSION_BUILT_IN_PROVIDERS.some((provider) => provider.id === OLLAMA_PROVIDER_ID)).toBe(true);
    expect(getExtensionProviderMeta(OLLAMA_PROVIDER_ID)).toMatchObject({
      id: OLLAMA_PROVIDER_ID,
      label: 'Ollama',
      endpoint: OLLAMA_DEFAULT_ENDPOINT,
    });
    expect(getExtensionProviderMeta(OLLAMA_PROVIDER_ID).kind).toBeUndefined();
    expect(BUILT_IN_PROVIDERS.some((provider) => provider.id === OLLAMA_PROVIDER_ID)).toBe(false);
  });

  it('is configured with endpoint and model but no API key', () => {
    const config = {
      providerId: OLLAMA_PROVIDER_ID,
      providers: {
        [OLLAMA_PROVIDER_ID]: {
          apiKey: '',
          endpoint: OLLAMA_DEFAULT_ENDPOINT,
          model: 'qwen3:8b',
        },
      },
    };
    const runtime = resolveExtensionProviderSettings(config, OLLAMA_PROVIDER_ID);
    expect(runtime.apiKey).toBe('');
    expect(isExtensionProviderConfigured(runtime, OLLAMA_PROVIDER_ID)).toBe(true);
    expect(getExtensionConfiguredProviderIds(config)).toContain(OLLAMA_PROVIDER_ID);
  });

  it('accepts the local HTTP endpoint required by the default Ollama server', () => {
    expect(validateEndpointUrl(OLLAMA_DEFAULT_ENDPOINT)).toBe(OLLAMA_DEFAULT_ENDPOINT);
  });

  it('does not classify Ollama as a user custom provider', () => {
    expect(getExtensionCustomProviderIds({
      [OLLAMA_PROVIDER_ID]: { apiKey: '', endpoint: OLLAMA_DEFAULT_ENDPOINT, model: 'llama3.2' },
      'custom-abc': { apiKey: 'key', endpoint: 'https://example.com/v1', model: 'model' },
    })).toEqual(['custom-abc']);
  });

  it('prepares a transient compatibility key without persisting it', () => {
    const prepared = prepareExtensionProviderConfig({
      providerId: OLLAMA_PROVIDER_ID,
      apiKey: '',
      endpoint: OLLAMA_DEFAULT_ENDPOINT,
      model: 'llama3.2',
    });
    expect(prepared.apiKey).toBe(OLLAMA_API_KEY_SENTINEL);
    expect(prepared.endpoint).toBe(OLLAMA_DEFAULT_ENDPOINT);
    expect(prepared.model).toBe('llama3.2');
    expect(prepareExtensionProviderConfig({
      providerId: 'openai',
      apiKey: '',
      endpoint: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    }).apiKey).toBe('');
  });

  it('backfills endpoint/model from the stored entry or the official default', () => {
    // 共享读取链对 providers 条目缺 endpoint 的投影是空串，请求组装必须兜底
    const config = {
      providerId: OLLAMA_PROVIDER_ID,
      apiKey: '',
      endpoint: '',
      model: '',
      providers: {
        [OLLAMA_PROVIDER_ID]: { apiKey: '', endpoint: 'http://localhost:11434/v1', model: 'qwen3:8b' },
      },
    };
    const prepared = prepareExtensionProviderConfig(config);
    expect(prepared.endpoint).toBe('http://localhost:11434/v1');
    expect(prepared.model).toBe('qwen3:8b');

    const bare = prepareExtensionProviderConfig({
      ...config,
      providers: { [OLLAMA_PROVIDER_ID]: { apiKey: '', model: 'm' } },
    });
    expect(bare.endpoint).toBe(OLLAMA_DEFAULT_ENDPOINT);
    expect(bare.model).toBe('m');
  });

  it('describes the 403 origin rejection with an actionable OLLAMA_ORIGINS hint', () => {
    const hint = describeOllamaAccessError(OLLAMA_PROVIDER_ID, '翻译服务请求失败 (403)：Forbidden', 'abcdef');
    expect(hint).toContain('翻译服务请求失败 (403)');
    expect(hint).toContain('OLLAMA_ORIGINS=chrome-extension://abcdef/*');
    expect(describeOllamaAccessError('openai', '失败 (403)', 'abcdef')).toBe('失败 (403)');
    expect(describeOllamaAccessError(OLLAMA_PROVIDER_ID, '翻译服务请求失败 (500)：boom', 'abcdef')).toBe('翻译服务请求失败 (500)：boom');
  });
});
