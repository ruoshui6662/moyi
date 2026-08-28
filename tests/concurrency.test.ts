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
});
