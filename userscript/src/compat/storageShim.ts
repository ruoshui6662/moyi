/**
 * chrome.storage.local 最小子集 shim：get / set / remove / onChanged。
 *
 * 现有共享模块（config.ts / translationCache.ts / floatingButton.ts）只依赖这四个成员。
 * 用 GM 存储实现后，这些模块无需任何修改即可在脚本环境运行，数据结构与扩展版完全兼容。
 *
 * 降级链：GM 存储 → localStorage（尽力而为，键加前缀避免冲突）→ 内存（隐私模式兜底）。
 */

import { getGm, getAddValueChangeListener } from './gm';

type StorageChange = { oldValue?: unknown; newValue?: unknown };
type ChangeRecord = Record<string, StorageChange>;
type StorageListener = (changes: ChangeRecord, areaName: string) => void;

const LOCAL_PREFIX = 'moyi:gm-fallback:';
const memoryStore = new Map<string, unknown>();

const readRaw = (key: string): unknown => {
  const api = getGm();
  if (api) {
    try {
      return api.getValue(key);
    } catch {
      // 落入 localStorage 兜底
    }
  }
  try {
    const raw = window.localStorage.getItem(LOCAL_PREFIX + key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return memoryStore.get(key);
  }
};

const writeRaw = (key: string, value: unknown): void => {
  const api = getGm();
  if (api) {
    try {
      if (value === undefined) api.deleteValue(key);
      else api.setValue(key, value);
      return;
    } catch {
      // 落入 localStorage 兜底
    }
  }
  try {
    if (value === undefined) window.localStorage.removeItem(LOCAL_PREFIX + key);
    else window.localStorage.setItem(LOCAL_PREFIX + key, JSON.stringify(value) ?? 'null');
  } catch {
    if (value === undefined) memoryStore.delete(key);
    else memoryStore.set(key, value);
  }
};

const listeners = new Set<StorageListener>();

const fireListeners = (changes: ChangeRecord): void => {
  for (const listener of [...listeners]) {
    try {
      listener(changes, 'local');
    } catch {
      // 单个监听器异常不影响其他监听器
    }
  }
};

export const installStorageShim = (): void => {
  const holder = window as Omit<typeof window, 'chrome'> & { chrome?: Record<string, unknown> };
  holder.chrome ??= {};
  const chrome = holder.chrome as Record<string, unknown>;

  chrome.storage = {
    local: {
      get: async (keys: string | string[] | null): Promise<Record<string, unknown>> => {
        const requested =
          keys === null || keys === undefined ? [] : Array.isArray(keys) ? keys : [keys];
        const result: Record<string, unknown> = {};
        for (const key of requested) {
          const value = readRaw(key);
          if (value !== undefined) result[key] = value;
        }
        return result;
      },
      set: async (items: Record<string, unknown>): Promise<void> => {
        const changes: ChangeRecord = {};
        for (const [key, value] of Object.entries(items)) {
          const oldValue = readRaw(key);
          writeRaw(key, value);
          changes[key] = { oldValue, newValue: value };
        }
        fireListeners(changes);
      },
      remove: async (keys: string | string[]): Promise<void> => {
        const list = Array.isArray(keys) ? keys : [keys];
        const changes: ChangeRecord = {};
        for (const key of list) {
          const oldValue = readRaw(key);
          writeRaw(key, undefined);
          changes[key] = { oldValue, newValue: undefined };
        }
        fireListeners(changes);
      },
    },
    onChanged: {
      addListener: (listener: StorageListener): void => {
        listeners.add(listener);
      },
      removeListener: (listener: StorageListener): void => {
        listeners.delete(listener);
      },
    },
  };
};

/**
 * 跨标签页热同步：把指定键的远端（其他标签页）GM 值变更映射为 storage.onChanged。
 * 对每个需要热同步的键调用一次；管理器不支持监听时静默降级。
 */
export const watchKeyForRemoteChanges = (keys: string[]): void => {
  const addListener = getAddValueChangeListener();
  if (!addListener) return;
  for (const key of keys) {
    try {
      addListener(
        key,
        (_key, oldValue, newValue, remote) => {
          if (!remote) return;
          fireListeners({ [key]: { oldValue, newValue } });
        },
      );
    } catch {
      // 单键监听失败不影响功能
    }
  }
};
