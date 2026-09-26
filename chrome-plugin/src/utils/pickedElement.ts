/**
 * 拾取结果的瞬时交接键：拾取器（内容脚本）写入 → 设置页监听 storage.onChanged 回填表单。
 * 用独立键而非 runtime 消息：设置页常驻另一标签页，消息不跨页可靠，storage 变更天然跨页广播。
 */

export const PICKED_ELEMENT_KEY = 'moyi-picked-element';

export interface PickedElement {
  selector: string;
  unique: boolean;
  label: string;
  url: string;
  title: string;
  textSample: string;
  pickedAt: number;
}

export const savePickedElement = async (picked: PickedElement): Promise<void> => {
  await chrome.storage.local.set({ [PICKED_ELEMENT_KEY]: picked });
};

export const loadPickedElement = async (): Promise<PickedElement | null> => {
  const stored = await chrome.storage.local.get(PICKED_ELEMENT_KEY);
  const value = stored[PICKED_ELEMENT_KEY] as PickedElement | undefined;
  return value && typeof value.selector === 'string' ? value : null;
};
