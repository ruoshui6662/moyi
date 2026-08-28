import { describe, expect, it, vi } from 'vitest';

import {
  selectPendingBatch,
  SubtitleScheduler,
  type SchedulerOptions,
} from '../chrome-plugin/src/utils/subtitles/scheduler';
import type { SubtitleCue } from '../chrome-plugin/src/utils/subtitles/trackLoader';

const OPTIONS: SchedulerOptions = {
  lookAheadMs: 30_000,
  backWindowMs: 5_000,
  batchSize: 5,
  maxAttempts: 2,
};

const cue = (start: number, end: number, text: string): SubtitleCue => ({ start, end, text });

const CUES: SubtitleCue[] = [
  cue(0, 2000, 'past'),
  cue(28_000, 30_000, 'ahead-near'),
  cue(40_000, 42_000, 'ahead-far'),
  cue(80_000, 82_000, 'ahead-beyond'),
];

const emptyState = {
  translatedTexts: new Set<string>(),
  pendingTexts: new Set<string>(),
  failedCounts: new Map<string, number>(),
};

describe('selectPendingBatch 窗口挑选', () => {
  it('只挑窗口内、未完成、未在途的文本，并按 batch 上限截断', () => {
    const state = {
      ...emptyState,
      translatedTexts: new Set(['past', 'ahead-near']),
    };
    expect(selectPendingBatch(CUES, 25_000, 1, OPTIONS, state)).toEqual(['ahead-far']);
  });

  it('回看窗口内刚过的字幕仍可补翻；超出则不再翻', () => {
    const state = { ...emptyState };
    // currentTime=2000：backWindow 5s → past(0) 在窗口内
    expect(selectPendingBatch(CUES, 2_000, 1, OPTIONS, state)).toContain('past');
    // currentTime=60_000：已过字幕全部滑出回看窗，不再补翻；只剩前方 80s 的字幕在预取窗内
    const picked = selectPendingBatch(CUES, 60_000, 1, OPTIONS, state);
    expect(picked).toEqual(['ahead-beyond']);
  });

  it('倍速放大预取窗（上限 4 倍），快进时提前更多', () => {
    const state = { ...emptyState };
    // rate=1 → 窗口 [20s,50s]：不含 ahead-beyond(80s)
    expect(selectPendingBatch(CUES, 20_000, 1, OPTIONS, state)).not.toContain('ahead-beyond');
    // rate=4 → 窗口 [15s,140s]：含 ahead-beyond
    expect(selectPendingBatch(CUES, 20_000, 4, OPTIONS, state)).toContain('ahead-beyond');
    // 非法倍速按 1 处理
    expect(selectPendingBatch(CUES, 20_000, Number.NaN, OPTIONS, state)).toEqual(
      selectPendingBatch(CUES, 20_000, 1, OPTIONS, state),
    );
  });

  it('失败达到 maxAttempts 的文本不再重试', () => {
    const state = {
      ...emptyState,
      failedCounts: new Map([['ahead-far', 2]]),
    };
    // ahead-far 已达重试上限被排除；窗口内其余未完成文本照常挑选
    expect(selectPendingBatch(CUES, 25_000, 1, OPTIONS, state)).toEqual(['ahead-near']);
  });
});

describe('无效结果处理（空串/错误占位不计为译文）', () => {
  it('通道抛错时触发 onTranslateError 钩子并计入失败', async () => {
    const onTranslateError = vi.fn();
    const scheduler = new SubtitleScheduler(
      async () => { throw new Error('翻译连接已中断。'); },
      OPTIONS,
      { onTranslateError },
    );
    await scheduler.tick([{ ...cue(0, 1000, 'err') }], 0, 1);
    expect(onTranslateError).toHaveBeenCalledWith('翻译连接已中断。');
    expect(scheduler.lookup('err')).toBeUndefined();
    expect(scheduler.getStats()).toEqual({ translatedCount: 0, failedCount: 1 });
  });

  it('空结果按失败计数并有限重试，不再无限打转', async () => {
    let calls = 0;
    const scheduler = new SubtitleScheduler(async () => {
      calls += 1;
      return ['', ''];
    }, OPTIONS);
    for (let round = 0; round < 4; round += 1) {
      await scheduler.tick([{ ...cue(0, 1000, 'empty') }], 0, 1);
    }
    expect(calls).toBe(2);
    expect(scheduler.lookup('empty')).toBeUndefined();
    expect(scheduler.getStats()).toEqual({ translatedCount: 0, failedCount: 2 });
  });

  it('后台错误占位「翻译失败：…」不入库、不展示，并触发批次失败回调', async () => {
    const onBatchFailure = vi.fn();
    const scheduler = new SubtitleScheduler(
      async () => ['翻译失败：配额超限'],
      OPTIONS,
      { onBatchFailure },
    );
    await scheduler.tick([{ ...cue(0, 1000, 'boom') }], 0, 1);
    expect(scheduler.lookup('boom')).toBeUndefined();
    expect(onBatchFailure).toHaveBeenCalledWith([{ text: 'boom', result: '翻译失败：配额超限' }]);
  });

  it('混合批次：有效译文入库，同批无效条目单独计失败', async () => {
    const onNewTranslation = vi.fn();
    const onBatchFailure = vi.fn();
    const scheduler = new SubtitleScheduler(
      async () => ['好的译文', ''],
      OPTIONS,
      { onNewTranslation, onBatchFailure },
    );
    await scheduler.tick([{ ...cue(0, 1000, 'good') }, { ...cue(2000, 3000, 'bad') }], 0, 1);
    expect(scheduler.lookup('good')).toBe('好的译文');
    expect(onNewTranslation).toHaveBeenCalledTimes(1);
    expect(onBatchFailure).toHaveBeenCalledWith([{ text: 'bad', result: '' }]);
    expect(scheduler.getStats()).toEqual({ translatedCount: 1, failedCount: 1 });
  });
});

describe('SubtitleScheduler 行为', () => {
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  };

  it('翻译成功后可查得译文并回调缓存写入；已完成文本不再重复翻译', async () => {
    const translate = vi.fn(async (texts: string[]) => texts.map((text) => `译:${text}`));
    const onNewTranslation = vi.fn();
    const scheduler = new SubtitleScheduler(translate, OPTIONS, { onNewTranslation });

    await scheduler.tick([{ ...cue(0, 2000, 'hello') }], 0, 1);
    expect(scheduler.lookup('hello')).toBe('译:hello');
    expect(onNewTranslation).toHaveBeenCalledWith('hello', '译:hello');

    await scheduler.tick([{ ...cue(0, 2000, 'hello') }, { ...cue(3000, 5000, 'world') }], 0, 1);
    expect(translate).toHaveBeenCalledTimes(2);
    expect(translate.mock.calls[1][0]).toEqual(['world']);
  });

  it('单飞：在途批次存在时 tick 直接返回', async () => {
    const gate = deferred<string[]>();
    const scheduler = new SubtitleScheduler(async () => gate.promise, OPTIONS);

    const first = scheduler.tick([{ ...cue(0, 1000, 'a') }], 0, 1);
    const second = scheduler.tick([{ ...cue(2000, 3000, 'b') }], 0, 1);
    gate.resolve(['A']);
    await Promise.all([first, second]);
    // 第二次 tick 因单飞被跳过：b 未进入任何批次
    expect(scheduler.lookup('b')).toBeUndefined();
  });

  it('reset 后在途批次的返回结果被 generation 守卫丢弃', async () => {
    const gate = deferred<string[]>();
    const onNewTranslation = vi.fn();
    const scheduler = new SubtitleScheduler(async () => gate.promise, OPTIONS, { onNewTranslation });

    const running = scheduler.tick([{ ...cue(0, 1000, 'stale') }], 0, 1);
    scheduler.reset();
    gate.resolve(['STALE']);
    await running;
    expect(scheduler.lookup('stale')).toBeUndefined();
    expect(onNewTranslation).not.toHaveBeenCalled();
  });

  it('失败计入次数，重试到上限后放弃', async () => {
    let calls = 0;
    const scheduler = new SubtitleScheduler(async () => {
      calls += 1;
      throw new Error('boom');
    }, OPTIONS);

    for (let round = 0; round < 3; round += 1) {
      await scheduler.tick([{ ...cue(0, 1000, 'bad') }], 0, 1);
    }
    // maxAttempts=2：第三次 tick 时该文本已被排除，不再发起请求
    expect(calls).toBe(2);
    expect(scheduler.lookup('bad')).toBeUndefined();
  });

  it('seedFromCache 用持久化缓存预热，命中即视为完成', async () => {
    const translate = vi.fn(async (texts: string[]) => texts.map(() => 'NEW'));
    const scheduler = new SubtitleScheduler(translate, OPTIONS);
    scheduler.seedFromCache([{ ...cue(0, 1000, 'cached') }], (text) =>
      text === 'cached' ? '旧译文' : undefined);

    await scheduler.tick([{ ...cue(0, 1000, 'cached') }, { ...cue(2000, 3000, 'fresh') }], 0, 1);
    expect(scheduler.lookup('cached')).toBe('旧译文');
    expect(scheduler.lookup('fresh')).toBe('NEW');
    expect(translate.mock.calls[0][0]).toEqual(['fresh']);
  });
});
