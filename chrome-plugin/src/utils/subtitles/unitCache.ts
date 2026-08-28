/**
 * 字幕单元跨刷新缓存（sessionStorage）：同一标签页内反复刷新同一视频时，
 * 直接复用上次成功获取并重组好的字幕单元，完全不触网——既消除重复拉取，
 * 也从根上避开高频刷新引发的边缘风控负反馈。
 *
 * 选型依据：sessionStorage 生命周期 = 标签页——刷新保留、关页即清，
 * 天然匹配「反复刷新」场景且无长期残留；配额远小于字幕体量。
 */

import type { SubtitleCue } from './trackLoader';

export const UNIT_CACHE_PREFIX = 'moyi-yt-cues:';
/** X（Twitter）站点的独立键前缀：与 YouTube 缓存互不污染。 */
export const UNIT_CACHE_PREFIX_X = 'moyi-x-cues:';

/** TTL 30 分钟：覆盖「反复刷新调试/回看」场景，过期后回归正常拉取。 */
export const UNIT_CACHE_TTL_MS = 30 * 60 * 1000;

/** 单条目序列化上限：超出视为异常体量不落盘（保护 ~5MB 配额）。 */
const MAX_ENTRY_BYTES = 1_500_000;

export interface UnitCacheEntry {
  savedAt: number;
  units: SubtitleCue[];
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const buildUnitCacheKey = (
  videoId: string,
  languageCode: string,
  kind?: string,
  prefix: string = UNIT_CACHE_PREFIX,
): string =>
  `${prefix}${videoId}:${languageCode}:${kind || 'manual'}`;

const isValidUnits = (value: unknown): value is SubtitleCue[] =>
  Array.isArray(value)
  && value.length > 0
  && value.every((unit) =>
    typeof (unit as SubtitleCue | null)?.text === 'string'
    && Number.isFinite((unit as SubtitleCue | null)?.start)
    && Number.isFinite((unit as SubtitleCue | null)?.end));

export const readCachedUnits = (
  storage: StorageLike,
  key: string,
  now: number,
): SubtitleCue[] | null => {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as Partial<UnitCacheEntry> | null;
    if (!entry || typeof entry.savedAt !== 'number' || !isValidUnits(entry.units)) return null;
    if (now - entry.savedAt > UNIT_CACHE_TTL_MS) {
      storage.removeItem(key);
      return null;
    }
    return entry.units;
  } catch {
    return null;
  }
};

export const writeCachedUnits = (
  storage: StorageLike,
  key: string,
  units: SubtitleCue[],
  now: number,
): void => {
  try {
    const payload = JSON.stringify({ savedAt: now, units } satisfies UnitCacheEntry);
    if (payload.length > MAX_ENTRY_BYTES) return;
    storage.setItem(key, payload);
  } catch {
    // 配额满或存储不可用：静默降级，不影响本次会话
  }
};
