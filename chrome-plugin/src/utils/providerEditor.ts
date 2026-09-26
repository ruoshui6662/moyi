/**
 * 自定义服务商编辑器的**决策逻辑**（纯函数，无 DOM/存储依赖）。
 *
 * 抽出来的原因：v0.1.21 的「删除服务商无效」根因是一条写反的守卫
 * （`if (!isDraft && !draftProviderIds.has(id)) return`）——它藏在 UI 事件里，
 * 静默 return、零测试覆盖，bug 从上线活到用户反馈。教训：凡是「按钮该不该
 * 生效 / 删除后落到哪 / 名字怎么回落」的判断，都必须离开 UI 层。
 *
 * 术语：
 * - saved（已保存）：providers 表里有条目；
 * - draft（草稿）：只在内存里（draftIds/draftNames），尚未落盘。
 */

import { isCustomProviderId, type ProviderSettings } from './providers';

/** 草稿态：未落盘的服务商。UI 持有，逻辑只读。 */
export interface DraftState {
  ids: ReadonlySet<string>;
  names: ReadonlyMap<string, string>;
}

/** 该服务商是否可被删除：自定义 + （已保存 或 草稿）。内建服务商永不显示删除入口。 */
export const canDeleteProvider = (
  id: string,
  providers: Readonly<Record<string, ProviderSettings>>,
  drafts: DraftState,
): boolean => isCustomProviderId(id) && (Boolean(providers[id]) || drafts.ids.has(id));

/** 是否为「未保存的草稿」。 */
export const isDraftProvider = (
  id: string,
  providers: Readonly<Record<string, ProviderSettings>>,
  drafts: DraftState,
): boolean => !providers[id] && drafts.ids.has(id);

/** 显示名优先级：已保存条目名 > 草稿名 > 「自定义服务商」默认。 */
export const resolveProviderName = (
  id: string,
  providers: Readonly<Record<string, ProviderSettings>>,
  drafts: DraftState,
): string => providers[id]?.name?.trim() || drafts.names.get(id)?.trim() || '自定义服务商';

/**
 * 删除已保存服务商后的落点：删的是当前激活项 → 优先切到**剩余自定义**（按存储序），
 * 否则 openai；删的不是当前项 → 保持当前激活。v0.1.21 前硬跳 openai，会把用户
 * 从还存在的自定义服务商上踢走。
 */
export const nextActiveProviderAfterDelete = (
  providers: Readonly<Record<string, ProviderSettings>>,
  deletedId: string,
  currentId: string,
): string => {
  if (currentId !== deletedId) return currentId;
  // 防御：即使传入表里仍带着被删项（调用方忘了先移除），也绝不会把落点算成它自己
  const remainingCustom = Object.keys(providers).find((id) => isCustomProviderId(id) && id !== deletedId);
  return remainingCustom ?? 'openai';
};

/** 从 providers 表移除一项，返回新表（不改入参）。 */
export const withoutProvider = (
  providers: Readonly<Record<string, ProviderSettings>>,
  id: string,
): Record<string, ProviderSettings> => {
  const next = { ...providers };
  delete next[id];
  return next;
};

/**
 * 草稿名更新：空名视为清除（回落默认文案）。
 * 已保存的条目名不由草稿态覆盖——名字随保存一并落盘。
 */
export const nextDraftNames = (
  names: ReadonlyMap<string, string>,
  id: string,
  rawName: string,
  providers: Readonly<Record<string, ProviderSettings>>,
): Map<string, string> => {
  const next = new Map(names);
  if (providers[id]) return next; // 已保存：草稿名不参与
  const name = rawName.trim();
  if (name) next.set(id, name);
  else next.delete(id);
  return next;
};

/** 删除草稿后的草稿态（ids/names 同步清理）。 */
export const afterDraftRemoved = (
  drafts: DraftState,
  id: string,
): DraftState => {
  const ids = new Set(drafts.ids);
  ids.delete(id);
  const names = new Map(drafts.names);
  names.delete(id);
  return { ids, names };
};

/** 保存成功后清除该条目的草稿标记。 */
export const afterProviderSaved = (drafts: DraftState, id: string): DraftState =>
  afterDraftRemoved(drafts, id);

/** 删除确认弹窗的文案（草稿=放弃/已保存=删除，两套语义不可混用）。 */
export const deleteConfirmCopy = (
  id: string,
  providers: Readonly<Record<string, ProviderSettings>>,
  drafts: DraftState,
): { title: string; body: string[]; confirmLabel: string } => {
  const name = resolveProviderName(id, providers, drafts);
  if (isDraftProvider(id, providers, drafts)) {
    return {
      title: '放弃未保存的服务商？',
      body: [`「${name}」尚未保存，放弃后已填写的内容将被丢弃。`],
      confirmLabel: '放弃',
    };
  }
  return {
    title: `删除「${name}」？`,
    body: [`「${name}」的 API Key 与服务配置将被清除。`, '此操作无法撤销。'],
    confirmLabel: '删除服务商',
  };
};
