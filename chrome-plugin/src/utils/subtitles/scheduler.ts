/**
 * 字幕翻译调度：只翻译播放位置前方一个小窗口内的 cue（预取），
 * 按原文去重、单飞（同一时刻至多一个在途批次）、generation 守卫防止
 * 切视频后旧批次的返回结果写入新会话。
 */

import type { SubtitleCue } from './trackLoader';

export interface SchedulerOptions {
  /** 预取窗口：向前翻多少毫秒的字幕（默认 30 秒）。 */
  lookAheadMs?: number;
  /** 回看窗口：已过字幕保留多久仍可补翻（默认 5 秒）。 */
  backWindowMs?: number;
  /** 单批最大条数。 */
  batchSize?: number;
  /** 同一条文本的最大自动重试次数，超过后本次会话不再尝试。 */
  maxAttempts?: number;
}

const DEFAULT_OPTIONS: Required<SchedulerOptions> = {
  lookAheadMs: 30_000,
  backWindowMs: 5_000,
  batchSize: 5,
  maxAttempts: 2,
};

export type TranslateFn = (texts: string[]) => Promise<string[]>;

export interface SchedulerStateSnapshot {
  translatedTexts: ReadonlySet<string>;
  pendingTexts: ReadonlySet<string>;
  failedCounts: ReadonlyMap<string, number>;
}

/**
 * 纯函数：挑选当前播放位置窗口内需要翻译的文本批次。
 * 窗口随倍速放大（快进时提前更多），上限钳制到 4 倍避免一次排入过多请求。
 */
export const selectPendingBatch = (
  cues: SubtitleCue[],
  currentTimeMs: number,
  playbackRate: number,
  options: SchedulerOptions,
  state: SchedulerStateSnapshot,
): string[] => {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const rate = Math.min(4, Math.max(1, Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1));
  const windowStart = currentTimeMs - opts.backWindowMs;
  const windowEnd = currentTimeMs + opts.lookAheadMs * rate;

  const picked: string[] = [];
  for (const cue of cues) {
    if (cue.start < windowStart) continue;
    if (cue.start > windowEnd) break;
    const text = cue.text;
    if (picked.includes(text)) continue;
    if (state.translatedTexts.has(text) || state.pendingTexts.has(text)) continue;
    if ((state.failedCounts.get(text) ?? 0) >= opts.maxAttempts) continue;
    picked.push(text);
    if (picked.length >= opts.batchSize) break;
  }
  return picked;
};

/**
 * 后台批量通道的约定：单批请求失败不抛错，而是把条目填成「翻译失败：…」；
 * 模型未按 <paragraph_N> 协议输出时对应条目为空串。
 * 这两类都不算有效译文：前者入库会展示错误文案，后者丢弃会造成无限重试。
 */
export const BATCH_FAILURE_PREFIX = '翻译失败：';

export const isUsableTranslation = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && !value.startsWith(BATCH_FAILURE_PREFIX);

export interface SchedulerHooks {
  /** 新译文产生（非缓存命中）时回调；引擎用它做持久化缓存刷写。 */
  onNewTranslation?: (text: string, translation: string) => void;
  /** 一批中出现无效结果（空串/错误占位）时回调；引擎用它记录诊断日志。 */
  onBatchFailure?: (items: { text: string; result: string }[]) => void;
  /** 翻译通道抛错（网络/服务商/扩展上下文失效）时回调；引擎用它做状态提示。 */
  onTranslateError?: (message: string) => void;
}

export class SubtitleScheduler {
  private readonly options: Required<SchedulerOptions>;
  private readonly hooks: SchedulerHooks;

  private translations = new Map<string, string>();
  private pending = new Set<string>();
  private failed = new Map<string, number>();
  private generation = 0;
  private inflight = false;

  constructor(
    private readonly translate: TranslateFn,
    options: SchedulerOptions = {},
    hooks: SchedulerHooks = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.hooks = hooks;
  }

  /** 会话重置（切视频）：作废在途批次、清空排队状态；已译结果与缓存语义保留。 */
  reset(): void {
    this.generation += 1;
    this.pending.clear();
    this.inflight = false;
  }

  /** 用持久化缓存预热：lookup 返回非空的记为已完成，返回空的不动。 */
  seedFromCache(cues: SubtitleCue[], lookup: (text: string) => string | undefined): void {
    for (const cue of cues) {
      const hit = lookup(cue.text);
      if (hit !== undefined && !this.translations.has(cue.text)) {
        this.translations.set(cue.text, hit);
      }
    }
  }

  lookup(text: string | null | undefined): string | undefined {
    if (!text) return undefined;
    return this.translations.get(text);
  }

  /** 会话级统计：translated=已入库译文数；failed=累计无效/失败次数（含重试）。 */
  getStats(): { translatedCount: number; failedCount: number } {
    return {
      translatedCount: this.translations.size,
      failedCount: [...this.failed.values()].reduce((sum, count) => sum + count, 0),
    };
  }

  /**
   * 播放进度驱动：挑一批待译文本发起批量翻译。
   * 已有在途批次时直接返回——timeupdate 频率高，下一拍自然续上。
   */
  async tick(cues: SubtitleCue[], currentTimeMs: number, playbackRate: number): Promise<void> {
    if (this.inflight) return;
    const batch = selectPendingBatch(cues, currentTimeMs, playbackRate, this.options, {
      translatedTexts: new Set(this.translations.keys()),
      pendingTexts: this.pending,
      failedCounts: this.failed,
    });
    if (batch.length === 0) return;

    const generation = this.generation;
    for (const text of batch) this.pending.add(text);
    this.inflight = true;
    try {
      const results = await this.translate(batch);
      if (generation !== this.generation) return;
      const invalid: { text: string; result: string }[] = [];
      batch.forEach((text, index) => {
        const translation = results[index];
        if (isUsableTranslation(translation)) {
          this.translations.set(text, translation);
          this.hooks.onNewTranslation?.(text, translation);
        } else {
          // 无效结果按一次失败计：有限重试而非无限打转
          this.failed.set(text, (this.failed.get(text) ?? 0) + 1);
          invalid.push({ text, result: typeof translation === 'string' ? translation : '' });
        }
      });
      if (invalid.length > 0) this.hooks.onBatchFailure?.(invalid);
    } catch (error) {
      if (generation !== this.generation) return;
      this.hooks.onTranslateError?.(error instanceof Error ? error.message : String(error));
      for (const text of batch) {
        this.failed.set(text, (this.failed.get(text) ?? 0) + 1);
      }
    } finally {
      this.inflight = false;
      if (generation === this.generation) {
        for (const text of batch) this.pending.delete(text);
      }
    }
  }
}
