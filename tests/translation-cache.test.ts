import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TRANSLATION_CACHE_KEY,
  cacheKey,
  clearTranslationCache,
  hashText,
  loadTranslationCache,
  saveTranslationCache,
} from '../chrome-plugin/src/entrypoints/content/translationCache';

const backing: Record<string, unknown> = {};
(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: async (key: string) => (key in backing ? { [key]: backing[key] } : {}),
      set: async (obj: Record<string, unknown>) => {
        Object.assign(backing, obj);
      },
      remove: async (key: string) => {
        delete backing[key];
      },
    },
  },
};

describe('translation cache', () => {
  beforeEach(() => {
    delete backing[TRANSLATION_CACHE_KEY];
  });

  it('hashes text stably and builds language-scoped keys', () => {
    expect(hashText('Hello world')).toBe(hashText('  Hello world  '));
    expect(hashText('A')).not.toBe(hashText('B'));
    expect(cacheKey('简体中文', 'Hello')).toBe('简体中文:' + hashText('Hello') + ':5');
    expect(cacheKey('English', 'Hello')).not.toBe(cacheKey('简体中文', 'Hello'));
  });

  it('round-trips saved translations through storage', async () => {
    const table = await loadTranslationCache();
    await saveTranslationCache(table, [
      { language: '简体中文', text: 'Hello', translation: '你好' },
      { language: '简体中文', text: 'World', translation: '世界' },
    ]);

    const reloaded = await loadTranslationCache();
    expect(reloaded[cacheKey('简体中文', 'Hello')]?.t).toBe('你好');
    expect(reloaded[cacheKey('简体中文', 'World')]?.t).toBe('世界');
  });

  it('skips blank translations and isolates languages', async () => {
    const table = await loadTranslationCache();
    await saveTranslationCache(table, [
      { language: '简体中文', text: 'Hi', translation: '   ' },
      { language: 'English', text: 'Dire', translation: '直译' },
    ]);
    expect(table[cacheKey('简体中文', 'Hi')]).toBeUndefined();
    expect(table[cacheKey('English', 'Dire')]?.t).toBe('直译');
  });

  it('prunes expired entries on load', async () => {
    const staleKey = cacheKey('简体中文', 'Old');
    backing[TRANSLATION_CACHE_KEY] = { [staleKey]: { t: '旧', at: Date.now() - 8 * 24 * 60 * 60 * 1000 } };

    const table = await loadTranslationCache();
    expect(table[staleKey]).toBeUndefined();
  });

  it('caps the table at MAX_ENTRIES by dropping the oldest, and clear resets it', async () => {
    const table = await loadTranslationCache();
    const now = Date.now();
    table[cacheKey('简体中文', 'seed')] = { t: 'seed', at: now - 1000 };
    // 塞满至超限：内存表先超量，再触发一次真实写入（带新 pairs）执行淘汰
    for (let i = 0; i < 6000; i += 1) {
      table[cacheKey('简体中文', `m${i}`)] = { t: 'x', at: now + i };
    }
    await saveTranslationCache(table, [{ language: '简体中文', text: 'end', translation: 'y' }]);

    const persisted = backing[TRANSLATION_CACHE_KEY] as Record<string, { at: number }>;
    const keys = Object.keys(persisted);
    expect(keys.length).toBeLessThanOrEqual(5000);
    // 最旧的 seed 应被淘汰
    expect(keys).not.toContain(cacheKey('简体中文', 'seed'));

    await clearTranslationCache();
    expect(backing[TRANSLATION_CACHE_KEY]).toBeUndefined();
  });
});