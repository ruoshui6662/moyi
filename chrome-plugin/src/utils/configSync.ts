/**
 * 配置备份/恢复、WebDAV 同步、场景 Profile、配置历史（零依赖，插件独有）。
 *
 * 密钥纪律（与 config.ts 的存储契约同源）：备份文件、DAV 远端、历史快照、Profile
 * 一律经 `stripSecrets` 剥离 apiKey/apiSecret——否则一次「备份」就会在存储或远端
 * 复制 N 份凭据，凭据泄露面与配置管理的「单一副本」原则同时被打破。导入/恢复时
 * 以当前配置的凭据为准（mergeSnapshot 只覆盖非敏感字段）。
 */

import { DEFAULT_CONFIG, type TranslatorConfig } from './config';
import { sanitizeSiteRules, type SiteRule } from './siteRules';

export const CONFIG_BACKUP_VERSION = 1;
export const CONFIG_HISTORY_MAX = 10;
export const PROFILES_MAX = 8;

export interface WebDavSettings {
  /** DAV 目录地址（如 https://dav.jianguoyun.com/dav/）。 */
  url: string;
  username: string;
  /** WebDAV 账户密码（与 API Key 同级：只存本机 chrome.storage）。 */
  password: string;
  /** 备份文件名（DAV 目录下的单文件）。 */
  path: string;
}

export const DEFAULT_WEBDAV: WebDavSettings = { url: '', username: '', password: '', path: 'moyi-config.json' };

/** 场景 Profile 快照：服务商 + 提示词风格 + 译文样式 + 悬浮球外观（不含数据与凭据）。 */
export interface ProfileSnapshot {
  providerId: string;
  promptStyle: string;
  useCustomPrompt: boolean;
  customPrompt: string;
  translationStyle: string;
  translationFontScale: number;
  translationColor: string;
  floatSize: number;
  floatOpacity: number;
}

export interface SceneProfile {
  id: string;
  name: string;
  snapshot: ProfileSnapshot;
}

export interface ConfigHistoryEntry {
  at: number;
  /** 触发来源（如「导入备份」「切换场景」），供设置页回滚列表辨识。 */
  label: string;
  snapshot: Partial<TranslatorConfig>;
}

const str = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);
const num = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

export const sanitizeWebDavSettings = (value: unknown): WebDavSettings => {
  const raw = (value ?? {}) as Partial<WebDavSettings>;
  const url = str(raw.url, 500);
  // 只接受 http(s)；公网用户请用 https（坚果云等均提供）
  const safeUrl = /^https?:\/\//i.test(url) ? url : '';
  return {
    url: safeUrl,
    username: str(raw.username, 100),
    password: str(raw.password, 200),
    path: str(raw.path, 100).replace(/^\/+/, '') || DEFAULT_WEBDAV.path,
  };
};

export const sanitizeProfiles = (value: unknown): SceneProfile[] => {
  if (!Array.isArray(value)) return [];
  const out: SceneProfile[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as { id?: unknown; name?: unknown; snapshot?: unknown };
    const name = str(candidate.name, 40);
    const id = str(candidate.id, 64);
    if (!name || !id || seen.has(id)) continue;
    const s = (candidate.snapshot ?? {}) as Record<string, unknown>;
    seen.add(id);
    out.push({
      id,
      name,
      snapshot: {
        providerId: str(s.providerId, 64) || DEFAULT_CONFIG.providerId,
        promptStyle: str(s.promptStyle, 32) || DEFAULT_CONFIG.promptStyle,
        useCustomPrompt: bool(s.useCustomPrompt, false),
        customPrompt: str(s.customPrompt, 500),
        translationStyle: str(s.translationStyle, 32) || DEFAULT_CONFIG.translationStyle,
        translationFontScale: num(s.translationFontScale, DEFAULT_CONFIG.translationFontSize, 0.8, 1.15),
        translationColor: str(s.translationColor, 7) || DEFAULT_CONFIG.translationColor,
        floatSize: Math.round(num(s.floatSize, DEFAULT_CONFIG.floatSize, 26, 48)),
        floatOpacity: num(s.floatOpacity, DEFAULT_CONFIG.floatOpacity, 0.4, 1),
      },
    });
    if (out.length >= PROFILES_MAX) break;
  }
  return out;
};

export const sanitizeConfigHistory = (value: unknown): ConfigHistoryEntry[] => {
  if (!Array.isArray(value)) return [];
  const out: ConfigHistoryEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as { at?: unknown; label?: unknown; snapshot?: unknown };
    if (!candidate.snapshot || typeof candidate.snapshot !== 'object') continue;
    out.push({
      at: num(candidate.at, 0, 0, Number.MAX_SAFE_INTEGER),
      label: str(candidate.label, 40) || '历史配置',
      snapshot: candidate.snapshot as Partial<TranslatorConfig>,
    });
    if (out.length >= CONFIG_HISTORY_MAX) break;
  }
  return out;
};

/** 剥离全部凭据：顶层与 providers 表逐项清空 apiKey/apiSecret，保留端点/模型等非敏感信息。 */
export const stripSecrets = (config: TranslatorConfig): Partial<TranslatorConfig> => {
  const { apiKey: _topKey, endpoint: _topEndpoint, model: _topModel, ...rest } = config;
  const providers: Record<string, unknown> = {};
  for (const [id, provider] of Object.entries(config.providers)) {
    const { apiKey: _k, apiSecret: _s, ...safe } = provider;
    providers[id] = safe;
  }
  return { ...rest, apiKey: '', endpoint: '', model: '', providers } as Partial<TranslatorConfig>;
};

export interface ConfigBackup {
  schemaVersion: number;
  exportedAt: string;
  config: Partial<TranslatorConfig>;
}

export const buildConfigBackup = (config: TranslatorConfig): ConfigBackup => ({
  schemaVersion: CONFIG_BACKUP_VERSION,
  exportedAt: new Date().toISOString(),
  config: stripSecrets(config),
});

export const serializeConfigBackup = (config: TranslatorConfig): string => JSON.stringify(buildConfigBackup(config), null, 2);

export interface ParsedBackup {
  snapshot?: Partial<TranslatorConfig>;
  exportedAt?: string;
  error?: string;
}

/** 解析备份文本：坏 JSON / 版本过新 / 结构不对都给出可读错误，绝不抛异常给 UI。 */
export const parseConfigBackup = (text: string): ParsedBackup => {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { error: '不是有效的 JSON 文件。' };
  }
  if (!payload || typeof payload !== 'object') return { error: '备份文件结构不对（应为 JSON 对象）。' };
  const backup = payload as Partial<ConfigBackup>;
  if (typeof backup.schemaVersion !== 'number') return { error: '缺少 schemaVersion，可能不是墨译的备份文件。' };
  if (backup.schemaVersion > CONFIG_BACKUP_VERSION) return { error: `备份版本（v${backup.schemaVersion}）高于当前插件，请先升级插件。` };
  if (!backup.config || typeof backup.config !== 'object') return { error: '备份文件缺少 config 字段。' };
  return { snapshot: backup.config as Partial<TranslatorConfig>, exportedAt: str(backup.exportedAt, 40) };
};

/** 把（无凭据的）快照合并到当前配置：凭据与 providers 凭据表原样保留。 */
export const mergeSnapshot = (
  current: TranslatorConfig,
  snapshot: Partial<TranslatorConfig>,
): TranslatorConfig => ({ ...current, ...snapshot, apiKey: current.apiKey, endpoint: current.endpoint, model: current.model });

/** 历史入栈：新快照在前，保留最近 CONFIG_HISTORY_MAX 条。 */
export const pushConfigHistory = (
  history: readonly ConfigHistoryEntry[],
  config: TranslatorConfig,
  label: string,
): ConfigHistoryEntry[] =>
  [{ at: Date.now(), label: label.slice(0, 40), snapshot: stripSecrets(config) }, ...history].slice(0, CONFIG_HISTORY_MAX);

// ── WebDAV 客户端（fetch + Basic auth，零依赖）──

const toBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export const webDavTargetUrl = (settings: WebDavSettings): string =>
  `${settings.url.replace(/\/+$/, '')}/${settings.path}`;

const DAV_TIMEOUT_MS = 15_000;

const davFetch = async (
  settings: WebDavSettings,
  method: 'GET' | 'PUT',
  body?: string,
): Promise<{ status: number; text: string }> => {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), DAV_TIMEOUT_MS);
  try {
    const response = await fetch(webDavTargetUrl(settings), {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Basic ${toBase64(`${settings.username}:${settings.password}`)}`,
        ...(method === 'PUT' ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
      },
      ...(method === 'PUT' && body !== undefined ? { body } : {}),
    });
    return { status: response.status, text: await response.text().catch(() => '') };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('WebDAV 请求超时（15 秒），请检查地址与网络。');
    }
    throw new Error(`WebDAV 请求失败：${error instanceof Error ? error.message : '未知错误'}`);
  } finally {
    globalThis.clearTimeout(timer);
  }
};

export interface WebDavProbe {
  reachable: boolean;
  hasBackup: boolean;
}

/** 连通性探测：GET 备份文件；200 有备份，404 可达但无备份，401 凭据错误（reachable=false + 抛错文案）。 */
export const webDavProbe = async (settings: WebDavSettings): Promise<WebDavProbe> => {
  const { status } = await davFetch(settings, 'GET');
  if (status === 200) return { reachable: true, hasBackup: true };
  if (status === 404) return { reachable: true, hasBackup: false };
  if (status === 401 || status === 403) throw new Error(`WebDAV 凭据被拒（${status}），请核对账号密码。`);
  throw new Error(`WebDAV 探测失败（HTTP ${status}），请核对目录地址。`);
};

export const webDavPut = async (settings: WebDavSettings, backupJson: string): Promise<void> => {
  const { status } = await davFetch(settings, 'PUT', backupJson);
  if (status >= 200 && status < 300) return;
  if (status === 401 || status === 403) throw new Error(`WebDAV 凭据被拒（${status}），上传未完成。`);
  if (status === 409) throw new Error('远端同名文件被占用（409），请改「文件名」后重试。');
  throw new Error(`WebDAV 上传失败（HTTP ${status}）。`);
};

export const webDavGet = async (settings: WebDavSettings): Promise<string | null> => {
  const { status, text } = await davFetch(settings, 'GET');
  if (status === 200) return text;
  if (status === 404) return null;
  if (status === 401 || status === 403) throw new Error(`WebDAV 凭据被拒（${status}）。`);
  throw new Error(`WebDAV 下载失败（HTTP ${status}）。`);
};

// ── 场景 Profile ──

export const buildProfileSnapshot = (config: TranslatorConfig): ProfileSnapshot => ({
  providerId: config.providerId,
  promptStyle: config.promptStyle,
  useCustomPrompt: config.useCustomPrompt,
  customPrompt: config.customPrompt,
  translationStyle: config.translationStyle,
  translationFontScale: config.translationFontSize,
  translationColor: config.translationColor,
  floatSize: config.floatSize,
  floatOpacity: config.floatOpacity,
});

/** 应用场景：覆盖风格类字段；凭据表不动（切到未配置的厂商时由 UI 提示去「翻译服务」补 Key）。 */
export const applyProfile = (config: TranslatorConfig, profile: SceneProfile): TranslatorConfig => ({
  ...config,
  providerId: profile.snapshot.providerId,
  promptStyle: profile.snapshot.promptStyle as TranslatorConfig['promptStyle'],
  useCustomPrompt: profile.snapshot.useCustomPrompt,
  customPrompt: profile.snapshot.customPrompt,
  translationStyle: profile.snapshot.translationStyle as TranslatorConfig['translationStyle'],
  translationFontSize: profile.snapshot.translationFontScale,
  translationColor: profile.snapshot.translationColor,
  floatSize: profile.snapshot.floatSize,
  floatOpacity: profile.snapshot.floatOpacity,
});

// ── 设置页订阅/场景的判断逻辑（纯函数）──

export interface SubscriptionFetchResult {
  url: string;
  rules?: SiteRule[];
  error?: string;
}

export interface SubscriptionMerge {
  /** 合并清洗后的规则集（空数组 = 本次全失败，应保留旧缓存）。 */
  rules: SiteRule[];
  failures: { url: string; error: string }[];
  /** 是否写入缓存：拿到规则、或全部成功（允许清空缓存）时才写；部分失败且无规则 → 不写。 */
  shouldWriteCache: boolean;
  success: boolean;
}

export const mergeSubscriptionResults = (results: readonly SubscriptionFetchResult[]): SubscriptionMerge => {
  const merged: SiteRule[] = [];
  const failures: { url: string; error: string }[] = [];
  for (const result of results) {
    if (result.error || !result.rules) {
      failures.push({ url: result.url, error: result.error || '未知错误' });
      continue;
    }
    merged.push(...result.rules);
  }
  const rules = sanitizeSiteRules(merged);
  return {
    rules,
    failures,
    shouldWriteCache: rules.length > 0 || failures.length === 0,
    success: failures.length === 0,
  };
};

export type ProfileSaveError = 'empty-name' | 'cap-reached';

/**
 * 场景保存准入：名称非空、数量未达上限；id 由调用方注入（UI 用 crypto.randomUUID，
 * 测试可传确定值）。超限时**不修改**入参。
 */
export const nextProfilesOnSave = (
  existing: readonly SceneProfile[],
  name: string,
  snapshot: ProfileSnapshot,
  makeId: () => string,
): { profiles: SceneProfile[]; error?: undefined; id?: string } | { profiles?: undefined; error: ProfileSaveError } => {
  const trimmed = name.trim();
  if (!trimmed) return { error: 'empty-name' };
  if (existing.length >= PROFILES_MAX) return { error: 'cap-reached' };
  const id = makeId();
  const profile: SceneProfile = { id, name: trimmed, snapshot };
  return { profiles: sanitizeProfiles([...existing, profile]), id };
};
