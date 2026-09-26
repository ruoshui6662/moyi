import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CARD_POSITION_KEY,
  clearCardPosition,
  clampToViewport,
  loadCardPosition,
  saveCardPosition,
} from '../chrome-plugin/src/utils/cardPosition';

describe('clampToViewport', () => {
  it('位置在视口内原样返回', () => {
    expect(clampToViewport({ left: 100, top: 120 }, 320, 200, 1000, 800)).toEqual({ left: 100, top: 120 });
  });

  it('越界夹取（换分辨率后不飞出屏幕）', () => {
    expect(clampToViewport({ left: -50, top: 9999 }, 320, 200, 1000, 800)).toEqual({ left: 8, top: 592 });
    expect(clampToViewport({ left: 5000, top: 5000 }, 320, 200, 1000, 800)).toEqual({ left: 672, top: 592 });
  });
});

describe('按站点记忆（chrome.storage 桩）', () => {
  let store: Record<string, unknown>;
  beforeEach(() => {
    store = {};
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (k: string) => ({ [k]: store[k] })),
          set: vi.fn(async (v: Record<string, unknown>) => { Object.assign(store, v); }),
        },
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('存取往返：按 hostname 隔离', async () => {
    await saveCardPosition('a.dev', { left: 10, top: 20 });
    await saveCardPosition('b.dev', { left: 30, top: 40 });
    expect(await loadCardPosition('a.dev')).toEqual({ left: 10, top: 20 });
    expect(await loadCardPosition('b.dev')).toEqual({ left: 30, top: 40 });
    expect(await loadCardPosition('c.dev')).toBeNull();
  });

  it('清除单站不影响其他站', async () => {
    await saveCardPosition('a.dev', { left: 1, top: 2 });
    await saveCardPosition('b.dev', { left: 3, top: 4 });
    await clearCardPosition('a.dev');
    expect(await loadCardPosition('a.dev')).toBeNull();
    expect(await loadCardPosition('b.dev')).toEqual({ left: 3, top: 4 });
  });

  it('同站重复拖动刷新 LRU 序（上限 50 丢最旧）', async () => {
    for (let i = 0; i < 50; i += 1) await saveCardPosition(`h${i}.dev`, { left: i, top: i });
    await saveCardPosition('h0.dev', { left: 999, top: 999 });
    await saveCardPosition('h50.dev', { left: 50, top: 50 });
    const map = store[CARD_POSITION_KEY] as Record<string, unknown>;
    expect(Object.keys(map)).toHaveLength(50);
    expect(await loadCardPosition('h0.dev')).toEqual({ left: 999, top: 999 });
    expect(await loadCardPosition('h1.dev')).toBeNull(); // 最旧的非 h0 被淘汰
  });

  it('存储异常时静默降级（不抛出）', async () => {
    vi.stubGlobal('chrome', { storage: { local: { get: async () => { throw new Error('quota'); }, set: async () => { throw new Error('quota'); } } } });
    expect(await loadCardPosition('a.dev')).toBeNull();
    await expect(saveCardPosition('a.dev', { left: 1, top: 1 })).resolves.toBeUndefined();
    await expect(clearCardPosition('a.dev')).resolves.toBeUndefined();
  });

  it('脏数据不炸：非数字/NaN 一律视为无记忆', async () => {
    store[CARD_POSITION_KEY] = { 'a.dev': { left: 'x', top: 2 }, 'b.dev': { left: NaN, top: 1 } };
    expect(await loadCardPosition('a.dev')).toBeNull();
    expect(await loadCardPosition('b.dev')).toBeNull();
  });
});
