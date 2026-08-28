import { describe, expect, it, vi } from 'vitest';

import {
  buildUnitCacheKey,
  readCachedUnits,
  UNIT_CACHE_TTL_MS,
  writeCachedUnits,
} from '../chrome-plugin/src/utils/subtitles/unitCache';
import type { SubtitleCue } from '../chrome-plugin/src/utils/subtitles/trackLoader';

const makeStorage = () => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string): string | null => data.get(key) ?? null,
    setItem: (key: string, value: string): void => { data.set(key, String(value)); },
    removeItem: (key: string): void => { data.delete(key); },
  };
};

const UNITS: SubtitleCue[] = [
  { start: 0, end: 3000, text: 'today we will talk about translation.' },
  { start: 4500, end: 5300, text: 'Let us start!' },
];

describe('字幕单元跨刷新缓存（sessionStorage）', () => {
  it('写入后可原样读回，键含视频/语言/类型维度', async () => {
    const storage = makeStorage();
    const key = buildUnitCacheKey('abc123', 'en', 'asr');
    expect(key).toBe('moyi-yt-cues:abc123:en:asr');
    writeCachedUnits(storage, key, UNITS, 1000);
    expect(readCachedUnits(storage, key, 2000)).toEqual(UNITS);
  });

  it('超过 TTL 后视为过期：返回空并清除条目', () => {
    const storage = makeStorage();
    const key = buildUnitCacheKey('abc123', 'en');
    writeCachedUnits(storage, key, UNITS, 1000);
    expect(readCachedUnits(storage, key, 1000 + UNIT_CACHE_TTL_MS - 1)).toEqual(UNITS);
    expect(readCachedUnits(storage, key, 1000 + UNIT_CACHE_TTL_MS + 1)).toBeNull();
    expect(storage.data.has(key)).toBe(false);
  });

  it('损坏 JSON 与非法结构安全返回空，不抛错', () => {
    const storage = makeStorage();
    storage.data.set('k1', 'not-json{{{');
    expect(readCachedUnits(storage, 'k1', 0)).toBeNull();
    storage.data.set('k2', JSON.stringify({ savedAt: 1, units: [{ wrong: 'shape' }] }));
    expect(readCachedUnits(storage, 'k2', 0)).toBeNull();
    storage.data.set('k3', JSON.stringify({ savedAt: 1, units: [] }));
    expect(readCachedUnits(storage, 'k3', 0)).toBeNull();
  });

  it('超大条目跳过写入（保护配额），读取为空', () => {
    const storage = makeStorage();
    const setItem = vi.spyOn(storage, 'setItem');
    const huge: SubtitleCue[] = [{ start: 0, end: 1, text: 'x'.repeat(1_600_000) }];
    writeCachedUnits(storage, 'big', huge, 0);
    expect(setItem).not.toHaveBeenCalled();
    expect(readCachedUnits(storage, 'big', 0)).toBeNull();
  });
});
