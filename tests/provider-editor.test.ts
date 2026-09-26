import { describe, expect, it } from 'vitest';
import {
  afterDraftRemoved,
  afterProviderSaved,
  canDeleteProvider,
  deleteConfirmCopy,
  isDraftProvider,
  nextActiveProviderAfterDelete,
  nextDraftNames,
  resolveProviderName,
  withoutProvider,
  type DraftState,
} from '../chrome-plugin/src/utils/providerEditor';
import { CUSTOM_PROVIDER_ID, type ProviderSettings } from '../chrome-plugin/src/utils/providers';

const saved = (name?: string, apiKey = 'sk-1'): ProviderSettings => ({ apiKey, endpoint: 'https://e.dev/v1', model: 'm', ...(name ? { name } : {}) });
const customId = 'custom-abc';
const draftsOf = (ids: string[] = [], names: [string, string][] = []): DraftState => ({
  ids: new Set(ids), names: new Map(names),
});

describe('canDeleteProvider（v0.1.21 反向守卫的回归网）', () => {
  it('已保存的自定义服务商可删除（这正是原 bug 被静默吞掉的路径）', () => {
    expect(canDeleteProvider(customId, { [customId]: saved() }, draftsOf())).toBe(true);
  });

  it('草稿态自定义服务商可删除（放弃）', () => {
    expect(canDeleteProvider(customId, {}, draftsOf([customId]))).toBe(true);
  });

  it('内建服务商永不显示删除入口', () => {
    expect(canDeleteProvider('openai', { openai: saved() }, draftsOf())).toBe(false);
    expect(canDeleteProvider('deepl', { deepl: saved() }, draftsOf(['deepl']))).toBe(false);
  });

  it('既未保存也非草稿的陌生 id 不可删除', () => {
    expect(canDeleteProvider(customId, {}, draftsOf())).toBe(false);
  });
});

describe('isDraftProvider / resolveProviderName', () => {
  it('草稿判定：未保存 + 在草稿集合', () => {
    expect(isDraftProvider(customId, {}, draftsOf([customId]))).toBe(true);
    expect(isDraftProvider(customId, { [customId]: saved() }, draftsOf([customId]))).toBe(false);
    expect(isDraftProvider(customId, {}, draftsOf())).toBe(false);
  });

  it('显示名优先级：已保存名 > 草稿名 > 默认', () => {
    const providers = { [customId]: saved('已保存名') };
    expect(resolveProviderName(customId, providers, draftsOf([customId], [[customId, '草稿名']]))).toBe('已保存名');
    expect(resolveProviderName(customId, {}, draftsOf([customId], [[customId, '草稿名']]))).toBe('草稿名');
    expect(resolveProviderName(customId, {}, draftsOf([customId]))).toBe('自定义服务商');
    expect(resolveProviderName(customId, {}, draftsOf())).toBe('自定义服务商');
  });
});

describe('nextActiveProviderAfterDelete（删除后的落点）', () => {
  it('删的是当前激活项 → 切到剩余自定义（存储序首个）', () => {
    const providers = { [customId]: saved(), 'custom-xyz': saved() };
    expect(nextActiveProviderAfterDelete(providers, customId, customId)).toBe('custom-xyz');
  });

  it('删的是当前激活项且无其他自定义 → 回退 openai', () => {
    expect(nextActiveProviderAfterDelete({}, customId, customId)).toBe('openai');
  });

  it('删的不是当前激活项 → 保持当前激活', () => {
    const providers = { [customId]: saved() };
    expect(nextActiveProviderAfterDelete(providers, customId, 'openai')).toBe('openai');
  });
});

describe('withoutProvider / 草稿态迁移', () => {
  it('withoutProvider 返回新表且不改入参', () => {
    const providers = { [customId]: saved(), openai: saved() };
    const next = withoutProvider(providers, customId);
    expect(next).not.toHaveProperty(customId);
    expect(providers).toHaveProperty(customId);
  });

  it('删除草稿：ids 与 names 同步清理', () => {
    const drafts = draftsOf([customId, 'custom-2'], [[customId, '甲'], ['custom-2', '乙']]);
    const cleared = afterDraftRemoved(drafts, customId);
    expect([...cleared.ids]).toEqual(['custom-2']);
    expect([...cleared.names]).toEqual([['custom-2', '乙']]);
  });

  it('保存成功：草稿标记清除', () => {
    const cleared = afterProviderSaved(draftsOf([customId], [[customId, '甲']]), customId);
    expect(cleared.ids.size).toBe(0);
    expect(cleared.names.size).toBe(0);
  });
});

describe('nextDraftNames', () => {
  it('空名视为清除草稿名（回落默认文案）', () => {
    const next = nextDraftNames(new Map([[customId, '旧名']]), customId, '   ', {});
    expect(next.has(customId)).toBe(false);
  });

  it('非空名 trim 后写入', () => {
    const next = nextDraftNames(new Map(), customId, '  新名  ', {});
    expect(next.get(customId)).toBe('新名');
  });

  it('已保存条目的草稿名不被草稿态覆盖（名字随保存落盘）', () => {
    const next = nextDraftNames(new Map([[customId, '旧草稿名']]), customId, '新草稿名', { [customId]: saved() });
    expect(next.get(customId)).toBe('旧草稿名');
  });
});

describe('deleteConfirmCopy（草稿=放弃 / 已保存=删除）', () => {
  it('草稿文案是「放弃」', () => {
    const copy = deleteConfirmCopy(customId, {}, draftsOf([customId], [[customId, '草稿甲']]));
    expect(copy.confirmLabel).toBe('放弃');
    expect(copy.title).toContain('放弃未保存');
    expect(copy.body[0]).toContain('草稿甲');
  });

  it('已保存文案是「删除服务商」且警示不可撤销', () => {
    const copy = deleteConfirmCopy(customId, { [customId]: saved('已保存甲') }, draftsOf());
    expect(copy.confirmLabel).toBe('删除服务商');
    expect(copy.title).toContain('已保存甲');
    expect(copy.body).toContain('此操作无法撤销。');
  });

  it('CUSTOM_PROVIDER_ID（历史自定义 id）同样适用', () => {
    const providers = { [CUSTOM_PROVIDER_ID]: saved() };
    expect(canDeleteProvider(CUSTOM_PROVIDER_ID, providers, draftsOf())).toBe(true);
    expect(nextActiveProviderAfterDelete({}, CUSTOM_PROVIDER_ID, CUSTOM_PROVIDER_ID)).toBe('openai');
  });
});
