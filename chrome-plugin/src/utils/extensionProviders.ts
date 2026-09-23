/**
 * 浏览器扩展专属服务商注册表。
 *
 * Ollama 只属于扩展发行版：油猴脚本直接复用 utils/providers.ts，
 * 因此不能把 Ollama 写进共享 BUILT_IN_PROVIDERS，否则油猴重新构建时
 * 也会暴露这个浏览器本机服务商。
 */

import type { TranslatorConfig } from './config';
import {
  BUILT_IN_PROVIDERS,
  getCustomProviderIds,
  getProviderDisplayName,
  getProviderMark,
  getProviderMeta,
  isBuiltInProvider,
  isProviderConfigured,
  resolveProviderSettings,
  type ProviderMeta,
  type ProviderRuntime,
  type ProviderSettings,
} from './providers';

export const OLLAMA_PROVIDER_ID = 'ollama';
export const OLLAMA_DEFAULT_ENDPOINT = 'http://localhost:11434/v1';
/** 仅供现有 OpenAI 客户端的必填字段使用，不写入配置。 */
export const OLLAMA_API_KEY_SENTINEL = 'ollama';

export const OLLAMA_PROVIDER_META: ProviderMeta = {
  id: OLLAMA_PROVIDER_ID,
  label: 'Ollama',
  endpoint: OLLAMA_DEFAULT_ENDPOINT,
  color: '#111111',
  mark: 'OL',
  fallbackModels: [],
};

export const EXTENSION_BUILT_IN_PROVIDERS: readonly ProviderMeta[] = [
  ...BUILT_IN_PROVIDERS,
  OLLAMA_PROVIDER_META,
];

export const isOllamaProviderId = (id: string): boolean => id === OLLAMA_PROVIDER_ID;

export const isExtensionBuiltInProvider = (id: string): boolean =>
  isOllamaProviderId(id) || isBuiltInProvider(id);

export const isExtensionCustomProviderId = (id: string): boolean =>
  !isExtensionBuiltInProvider(id);

export const getExtensionProviderMeta = (id: string): ProviderMeta =>
  isOllamaProviderId(id) ? OLLAMA_PROVIDER_META : getProviderMeta(id);

export const getExtensionProviderDisplayName = (
  providers: Record<string, ProviderSettings> | undefined,
  id: string,
): string => (isOllamaProviderId(id) ? OLLAMA_PROVIDER_META.label : getProviderDisplayName(providers, id));

export const getExtensionProviderMark = (
  providers: Record<string, ProviderSettings> | undefined,
  id: string,
): string => (isOllamaProviderId(id) ? OLLAMA_PROVIDER_META.mark : getProviderMark(providers, id));

export const getExtensionCustomProviderIds = (
  providers: Record<string, ProviderSettings> | undefined,
): string[] => getCustomProviderIds(providers).filter((id) => !isOllamaProviderId(id));

export const getExtensionRegisteredProviderIds = (
  providers: Record<string, ProviderSettings> | undefined,
): string[] => [
  ...EXTENSION_BUILT_IN_PROVIDERS.map((provider) => provider.id),
  ...getExtensionCustomProviderIds(providers),
];

export const resolveExtensionProviderSettings = (
  config: { providers?: Record<string, ProviderSettings>; endpoint?: string; apiKey?: string; model?: string },
  id: string,
): ProviderRuntime => {
  if (!isOllamaProviderId(id)) return resolveProviderSettings(config, id);
  const stored = config.providers?.[id];
  return {
    apiKey: stored?.apiKey ?? '',
    apiSecret: '',
    endpoint: stored?.endpoint ?? OLLAMA_DEFAULT_ENDPOINT,
    model: stored?.model ?? '',
    region: '',
  };
};

export const isExtensionProviderConfigured = (
  settings: Pick<ProviderRuntime, 'apiKey' | 'apiSecret' | 'endpoint' | 'model'>,
  id?: string,
): boolean => {
  if (isOllamaProviderId(id ?? '')) {
    return Boolean(settings.endpoint.trim() && settings.model.trim());
  }
  return isProviderConfigured(settings, id);
};

export const getExtensionConfiguredProviderIds = (
  config: Pick<TranslatorConfig, 'providers'>,
): string[] => getExtensionRegisteredProviderIds(config.providers).filter((id) =>
  isExtensionProviderConfigured(resolveExtensionProviderSettings(config, id), id),
);

/** 仅扩展侧切换服务商；Ollama 的空 Key 不会被写入持久配置。 */
export const activateExtensionConfiguredProvider = <T extends {
  providerId: string;
  apiKey: string;
  endpoint: string;
  model: string;
  providers?: Record<string, ProviderSettings>;
}>(config: T, id: string): T => {
  const registered = isExtensionBuiltInProvider(id)
    || Boolean(config.providers && Object.prototype.hasOwnProperty.call(config.providers, id));
  if (!registered) throw new Error('未知的翻译服务。');
  const runtime = resolveExtensionProviderSettings(config, id);
  if (!isExtensionProviderConfigured(runtime, id)) throw new Error('该翻译服务尚未完整配置。');
  return {
    ...config,
    providerId: id,
    apiKey: runtime.apiKey,
    endpoint: runtime.endpoint,
    model: runtime.model,
  };
};

/**
 * 组装后台请求配置。
 * Ollama 需要两件适配：① 共享读取链（getConfig 的投影）不感知扩展专属默认端点，
 * providers 条目缺 endpoint 时顶层投影为空串——这里从 providers 表重新解析并兜底默认值；
 * ② 无密码哨兵 Key 适配 OpenAI 客户端的必填合同。哨兵只存在于本次请求对象，绝不写回存储。
 * 其余服务商原样透传。
 */
export const prepareExtensionProviderConfig = <T extends {
  providerId: string;
  apiKey: string;
  endpoint?: string;
  model?: string;
  providers?: Record<string, ProviderSettings>;
}>(config: T): T => {
  if (!isOllamaProviderId(config.providerId)) return config;
  const runtime = resolveExtensionProviderSettings(config, config.providerId);
  return {
    ...config,
    apiKey: OLLAMA_API_KEY_SENTINEL,
    endpoint: runtime.endpoint || OLLAMA_DEFAULT_ENDPOINT,
    model: runtime.model || config.model || '',
  };
};

export const prepareExtensionRequestApiKey = (providerId: string, apiKey: string): string =>
  isOllamaProviderId(providerId) && !apiKey.trim() ? OLLAMA_API_KEY_SENTINEL : apiKey;

/**
 * Ollama 专属错误提示：本地服务的默认来源白名单不含扩展来源，403 时
 * 给出可操作的 OLLAMA_ORIGINS 配置指引；其余错误原样透传。
 */
export const describeOllamaAccessError = (
  providerId: string,
  message: string,
  extensionId: string,
): string => {
  if (!isOllamaProviderId(providerId) || !/\b403\b|forbidden/i.test(message)) return message;
  return `${message} 提示：Ollama 拒绝了扩展的访问来源（403），请在启动 Ollama 前设置 `
    + `OLLAMA_ORIGINS=chrome-extension://${extensionId}/* 放行扩展来源，然后重启 Ollama 再试。`;
};
