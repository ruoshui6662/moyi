/**
 * 油猴脚本适配层测试：在 jsdom 中模拟 GM API，验证
 *   - GM 能力探测；
 *   - chrome.storage.local shim（读写 / onChanged / 远端变更监听）；
 *   - chrome.runtime 消息总线 shim（sendMessage 异步应答 / connect 端口双向收发与断开）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type GmRecord = Map<string, unknown>;

const installGmMocks = (): { store: GmRecord; listeners: Map<string, Set<(k: string, o: unknown, n: unknown, remote: boolean) => void>> } => {
  const store: GmRecord = new Map();
  const listeners = new Map<string, Set<(k: string, o: unknown, n: unknown, remote: boolean) => void>>();
  vi.stubGlobal('GM_getValue', (key: string) => {
    if (!store.has(key)) throw new Error('not found');
    return store.get(key);
  });
  vi.stubGlobal('GM_setValue', (key: string, value: unknown) => {
    store.set(key, value);
    for (const listener of listeners.get(key) ?? []) listener(key, undefined, value, false);
  });
  vi.stubGlobal('GM_deleteValue', (key: string) => {
    store.delete(key);
  });
  vi.stubGlobal('GM_xmlhttpRequest', () => ({ abort: (): void => {} }));
  vi.stubGlobal('GM_addValueChangeListener', (key: string, listener: (k: string, o: unknown, n: unknown, remote: boolean) => void) => {
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key)!.add(listener);
    return listeners.get(key)!.size;
  });
  return { store, listeners };
};

const loadModules = async () => {
  const gm = await import('../userscript/src/compat/gm');
  const storage = await import('../userscript/src/compat/storageShim');
  const bus = await import('../userscript/src/compat/busShim');
  return { gm, storage, bus };
};

describe('userscript compat layer', () => {
  let mocks: ReturnType<typeof installGmMocks>;

  beforeEach(() => {
    mocks = installGmMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('getGm 探测到 GM 存储与网络能力', async () => {
    const { gm } = await loadModules();
    expect(gm.getGm()).not.toBeNull();
    expect(gm.hasGmXhr()).toBe(true);
  });

  it('storage shim：set/get 往返与 remove', async () => {
    const { storage } = await loadModules();
    storage.installStorageShim();
    const chromeApi = (window as unknown as { chrome: { storage: { local: {
      get: (k: string[]) => Promise<Record<string, unknown>>;
      set: (i: Record<string, unknown>) => Promise<void>;
      remove: (k: string[]) => Promise<void>;
    } } } }).chrome.storage;

    await chromeApi.local.set({ 'a-key': { nested: true } });
    const got = await chromeApi.local.get(['a-key']);
    expect(got['a-key']).toEqual({ nested: true });
    expect(mocks.store.get('a-key')).toEqual({ nested: true });

    await chromeApi.local.remove(['a-key']);
    const gone = await chromeApi.local.get(['a-key']);
    expect(gone['a-key']).toBeUndefined();
  });

  it('storage shim：本地 set 触发 onChanged；远端 GM 变更经 watchKey 映射', async () => {
    const { storage } = await loadModules();
    storage.installStorageShim();
    const chromeApi = (window as unknown as { chrome: { storage: {
      local: { set: (i: Record<string, unknown>) => Promise<void>; get: (k: string[]) => Promise<Record<string, unknown>> };
      onChanged: { addListener: (l: (c: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void) => void };
    } } }).chrome.storage;

    const seen: { key: string; newValue: unknown; area: string }[] = [];
    chromeApi.onChanged.addListener((changes, area) => {
      for (const [key, change] of Object.entries(changes)) seen.push({ key, newValue: change.newValue, area });
    });

    await chromeApi.local.set({ k1: 'v1' });
    expect(seen).toContainEqual({ key: 'k1', newValue: 'v1', area: 'local' });

    // 注册远端监听后，模拟其他标签页的 GM 写入（remote=true）应映射为 onChanged
    storage.watchKeyForRemoteChanges(['watched-key']);
    for (const fire of listenersOf(mocks.listeners, 'watched-key')) fire('watched-key', undefined, 'remote-2', true as unknown as false);
    expect(seen).toContainEqual({ key: 'watched-key', newValue: 'remote-2', area: 'local' });
  });

  it('bus shim：sendMessage 支持异步应答', async () => {
    const { bus } = await loadModules();
    bus.installBusShim();
    const runtime = (window as unknown as { chrome: { runtime: {
      sendMessage: (m: unknown) => Promise<unknown>;
      onMessage: { addListener: (l: (m: unknown, s: unknown, r: (resp: unknown) => void) => boolean | void) => void };
      connect: (d: { name?: string }) => unknown;
      onConnect: { addListener: (l: (port: never) => void) => void };
    } } }).chrome.runtime;

    runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if ((message as { type?: string }).type !== 'ping') return false;
      setTimeout(() => sendResponse({ ok: true, pong: (message as { text: string }).text }), 5);
      return true;
    });

    const result = (await runtime.sendMessage({ type: 'ping', text: 'hi' })) as { ok: boolean; pong: string };
    expect(result).toEqual({ ok: true, pong: 'hi' });
  });

  it('bus shim：connect 端口双向收发与断开通知', async () => {
    const { bus } = await loadModules();
    bus.installBusShim();
    const runtime = (window as unknown as { chrome: { runtime: {
      connect: (d: { name?: string }) => {
        name: string;
        postMessage: (m: unknown) => void;
        disconnect: () => void;
        onMessage: { addListener: (l: (m: unknown) => void) => void };
        onDisconnect: { addListener: (l: () => void) => void };
      };
      onConnect: { addListener: (l: (port: {
        name: string;
        postMessage: (m: unknown) => void;
        disconnect: () => void;
        onMessage: { addListener: (l: (m: unknown) => void) => void };
        onDisconnect: { addListener: (l: () => void) => void };
      }) => void) => void };
    } } }).chrome.runtime;

    const received: string[] = [];
    let serverDisconnected = false;
    let serverPort: Parameters<Parameters<typeof runtime.onConnect.addListener>[0]>[0] | null = null;

    runtime.onConnect.addListener((port) => {
      serverPort = port;
      if (port.name !== 'test-stream') return;
      port.onMessage.addListener((message) => {
        received.push(`server:${(message as { step: string }).step}`);
        port.postMessage({ echo: (message as { step: string }).step });
      });
      port.onDisconnect.addListener(() => {
        serverDisconnected = true;
      });
    });

    const client = runtime.connect({ name: 'test-stream' });
    const clientGot: string[] = [];
    client.onMessage.addListener((message) => {
      clientGot.push(String((message as { echo: string }).echo));
    });

    client.postMessage({ step: 'one' });
    client.postMessage({ step: 'two' });
    expect(received).toEqual(['server:one', 'server:two']);
    expect(clientGot).toEqual(['one', 'two']);

    client.disconnect();
    expect(serverDisconnected).toBe(true);
    expect(serverPort).not.toBeNull();
  });
});

/** 从 mock 注册表中取出指定键的监听器集合（测试辅助）。 */
const listenersOf = (
  listeners: Map<string, Set<(k: string, o: unknown, n: unknown, remote: boolean) => void>>,
  key: string,
): Set<(k: string, o: unknown, n: unknown, remote: boolean) => void> =>
  listeners.get(key) ?? new Set();
