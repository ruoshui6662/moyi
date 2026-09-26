import { describe, expect, it } from 'vitest';
import { BatchingScheduler, runWithConcurrency } from '../chrome-plugin/src/utils/concurrency';

describe('runWithConcurrency', () => {
  it('runs all tasks without exceeding the limit', async () => {
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const tasks = Array.from({ length: 7 }, (_, i) => async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(i);
      running -= 1;
    });

    await runWithConcurrency(tasks, 3);

    expect(order.length).toBe(7);
    expect(peak).toBe(3);
  });

  it('resolves immediately for an empty task list', async () => {
    await expect(runWithConcurrency([], 3)).resolves.toBeUndefined();
  });
});

describe('BatchingScheduler', () => {
  it('processes enqueued items in batches up to concurrency and reports idle', async () => {
    const batchSizes: number[] = [];
    let running = 0;
    let peak = 0;
    const scheduler = new BatchingScheduler({
      batchSize: 2,
      concurrency: 2,
      runBatch: async (items) => {
        running += 1;
        peak = Math.max(peak, running);
        batchSizes.push(items.length);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
      },
    });

    const items = Array.from({ length: 5 }, (_, i) => ({
      text: `p${i}`,
      element: document.createElement('p'),
    }));
    scheduler.enqueue(items);
    // enqueue 同步触发 drain：2 个 worker 立即各取一批（2+2），仅剩第 5 项排队
    expect(scheduler.pendingCount).toBe(1);
    await scheduler.waitForIdle();

    expect(batchSizes.reduce((sum, size) => sum + size, 0)).toBe(5);
    expect(peak).toBe(2);
    expect(scheduler.pendingCount).toBe(0);
  });

  it('supports late enqueue after going idle', async () => {
    const processed: number[] = [];
    const scheduler = new BatchingScheduler({
      batchSize: 2,
      concurrency: 2,
      runBatch: async (items) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        for (const item of items) processed.push(Number(item.text.slice(1)));
      },
    });

    scheduler.enqueue([
      { text: 'p0', element: document.createElement('p') },
      { text: 'p1', element: document.createElement('p') },
    ]);
    await scheduler.waitForIdle();

    scheduler.enqueue([{ text: 'p2', element: document.createElement('p') }]);
    await scheduler.waitForIdle();

    expect(processed).toEqual([0, 1, 2]);
  });

  it('clear drops pending items without running them', async () => {
    let runs = 0;
    const scheduler = new BatchingScheduler({
      batchSize: 1,
      concurrency: 1,
      runBatch: async () => {
        runs += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
    });

    scheduler.enqueue([
      { text: 'a', element: document.createElement('p') },
      { text: 'b', element: document.createElement('p') },
      { text: 'c', element: document.createElement('p') },
    ]);
    scheduler.clear();
    await scheduler.waitForIdle();

    expect(runs).toBeLessThanOrEqual(1);
  });

  it('front 入队插到队首（近窗口抢占预取积压），缺省行为不变', async () => {
    const order: string[] = [];
    const scheduler = new BatchingScheduler({
      batchSize: 1,
      concurrency: 1,
      runBatch: async (items) => {
        order.push(items[0]!.text);
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
    });

    scheduler.enqueue([
      { text: 'a', element: document.createElement('p') },
      { text: 'b', element: document.createElement('p') },
    ]);
    // drain 同步取走 a，b 在队列中
    scheduler.enqueue([{ text: 'c', element: document.createElement('p') }]);
    scheduler.enqueue([{ text: 'd', element: document.createElement('p') }], { front: true });
    await scheduler.waitForIdle();

    expect(order).toEqual(['a', 'd', 'b', 'c']);
  });

  it('maxBatchChars 按字符预算拆批，单项超预算仍独占一批（只拆批不拆段）', async () => {
    const batchChars: number[] = [];
    const scheduler = new BatchingScheduler({
      batchSize: 5,
      concurrency: 1,
      itemChars: (item) => item.text.length,
      maxBatchChars: 10,
      runBatch: async (items) => {
        batchChars.push(items.reduce((sum, item) => sum + item.text.length, 0));
        await new Promise((resolve) => setTimeout(resolve, 2));
      },
    });

    scheduler.enqueue([
      { text: 'aaaa', element: document.createElement('p') },     // 4
      { text: 'bbbbbb', element: document.createElement('p') },   // 6 → 4+6=10 同批
      { text: 'cccc', element: document.createElement('p') },     // 4 → 10+4>10 另起
      { text: 'x'.repeat(30), element: document.createElement('p') }, // 30 超预算独占
      { text: 'dd', element: document.createElement('p') },       // 2 → 独立尾批
    ]);
    await scheduler.waitForIdle();

    expect(batchChars).toEqual([10, 4, 30, 2]);
  });
});

describe('动态装箱（W2.1 请求数缩减）', () => {
  const makeItems = (count: number, chars: number) =>
    Array.from({ length: count }, (_, i) => ({
      text: 'x'.repeat(chars),
      element: document.createElement('p'),
    }));

  it('字符预算内短段落按条数上限 16 装箱：100×50 字符 → 7 批（旧上限 8 需 13 批，降 46%）', async () => {
    const batchSizes: number[] = [];
    const scheduler = new BatchingScheduler({
      batchSize: 16,
      concurrency: 1,
      itemChars: (item) => item.text.length,
      maxBatchChars: 6000,
      runBatch: async (items) => {
        batchSizes.push(items.length);
      },
    });
    scheduler.enqueue(makeItems(100, 50));
    await scheduler.waitForIdle();
    expect(batchSizes).toEqual([16, 16, 16, 16, 16, 16, 4]);
  });

  it('长段落由字符预算自动缩批：8×1000 字符 → 每批最多 6 段（6000 预算）', async () => {
    const batchSizes: number[] = [];
    const scheduler = new BatchingScheduler({
      batchSize: 16,
      concurrency: 1,
      itemChars: (item) => item.text.length,
      maxBatchChars: 6000,
      runBatch: async (items) => {
        batchSizes.push(items.length);
      },
    });
    scheduler.enqueue(makeItems(8, 1000));
    await scheduler.waitForIdle();
    expect(batchSizes).toEqual([6, 2]);
  });

  it('单段超预算独占一批（不拆段的既有契约保持）', async () => {
    const batchSizes: number[] = [];
    const scheduler = new BatchingScheduler({
      batchSize: 16,
      concurrency: 1,
      itemChars: (item) => item.text.length,
      maxBatchChars: 6000,
      runBatch: async (items) => {
        batchSizes.push(items.length);
      },
    });
    scheduler.enqueue(makeItems(3, 7000));
    await scheduler.waitForIdle();
    expect(batchSizes).toEqual([1, 1, 1]);
  });
});
