/**
 * 划词卡位置记忆（按站点）：用户拖过的位置存本机 chrome.storage.local，
 * 下次在同一站点弹出直接回到那里；双击复位则清除。
 *
 * 存储形态：{ [hostname]: { left, top } }，落盘前按视口夹取——换分辨率后
 * 也不会把卡片停在屏幕外。站点上限 50，超出丢最旧（LRU 语义：Map 插入序）。
 */

export const CARD_POSITION_KEY = 'moyi-selection-card-position';
const MAX_HOSTS = 50;

export interface CardPosition {
  left: number;
  top: number;
}

export type PositionMap = Record<string, CardPosition>;

/** 把位置夹进视口（保证任何分辨率下都完整可见）。 */
export const clampToViewport = (
  position: CardPosition,
  cardW: number,
  cardH: number,
  viewportW: number,
  viewportH: number,
  margin = 8,
): CardPosition => ({
  left: Math.max(margin, Math.min(position.left, viewportW - cardW - margin)),
  top: Math.max(margin, Math.min(position.top, viewportH - cardH - margin)),
});

/** 读取记忆（storage 不可用时静默降级为 null）。 */
export const loadCardPosition = async (host: string): Promise<CardPosition | null> => {
  try {
    const stored = await chrome.storage.local.get(CARD_POSITION_KEY);
    const map = (stored[CARD_POSITION_KEY] ?? {}) as PositionMap;
    const value = map[host];
    if (!value || typeof value.left !== 'number' || typeof value.top !== 'number') return null;
    if (!Number.isFinite(value.left) || !Number.isFinite(value.top)) return null;
    return { left: value.left, top: value.top };
  } catch {
    return null;
  }
};

export const saveCardPosition = async (host: string, position: CardPosition): Promise<void> => {
  try {
    const stored = await chrome.storage.local.get(CARD_POSITION_KEY);
    const map = { ...((stored[CARD_POSITION_KEY] ?? {}) as PositionMap) };
    delete map[host];
    map[host] = position; // 重新插入 = 刷新 LRU 序
    const entries = Object.entries(map);
    const trimmed = entries.length > MAX_HOSTS ? entries.slice(entries.length - MAX_HOSTS) : entries;
    await chrome.storage.local.set({ [CARD_POSITION_KEY]: Object.fromEntries(trimmed) });
  } catch {
    // 存储不可用：本次会话内仍可用（内存中的 userOffset 继续生效）
  }
};

export const clearCardPosition = async (host: string): Promise<void> => {
  try {
    const stored = await chrome.storage.local.get(CARD_POSITION_KEY);
    const map = { ...((stored[CARD_POSITION_KEY] ?? {}) as PositionMap) };
    delete map[host];
    await chrome.storage.local.set({ [CARD_POSITION_KEY]: map });
  } catch {
    // 同上
  }
};
