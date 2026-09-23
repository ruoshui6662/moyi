export const runWithConcurrency = async (
  tasks: (() => Promise<void>)[],
  limit: number,
): Promise<void> => {
  if (tasks.length === 0) return;
  const effectiveLimit = Math.max(1, Math.min(limit, tasks.length));
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < tasks.length) {
      const current = nextIndex;
      nextIndex += 1;
      await tasks[current]();
    }
  };

  await Promise.all(Array.from({ length: effectiveLimit }, () => worker()));
};

export class BatchingScheduler<T extends { element: HTMLElement } = { text: string; element: HTMLElement }> {
  private readonly batchSize: number;
  private readonly concurrency: number;
  private readonly runBatch: (items: T[]) => Promise<void>;
  private readonly itemChars?: (item: T) => number;
  private readonly maxBatchChars?: number;
  private pending: T[] = [];
  private activeWorkers = 0;
  private idleResolvers: (() => void)[] = [];

  constructor(options: {
    batchSize: number;
    concurrency: number;
    runBatch: (items: T[]) => Promise<void>;
    /** 可选：单项字符数，配合 maxBatchChars 按输入预算拆批。 */
    itemChars?: (item: T) => number;
    /** 可选：单批累计字符预算。只拆批、不拆段——单项超预算仍独占一批，保持段落契约不变。 */
    maxBatchChars?: number;
  }) {
    this.batchSize = options.batchSize;
    this.concurrency = options.concurrency;
    this.runBatch = options.runBatch;
    this.itemChars = options.itemChars;
    this.maxBatchChars = options.maxBatchChars;
  }

  /** 入队。`front: true` 插到队首（近窗口到达/跳读抢占预取积压）；缺省与原行为完全一致。 */
  enqueue(items: T[], options?: { front?: boolean }): void {
    if (options?.front && items.length > 0) this.pending.unshift(...items);
    else this.pending.push(...items);
    void this.drain();
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  waitForIdle(): Promise<void> {
    if (this.pending.length === 0 && this.activeWorkers === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  clear(): void {
    this.pending = [];
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0 && this.activeWorkers < this.concurrency) {
      const batch = this.takeBatch();
      if (batch.length === 0) continue;
      this.activeWorkers += 1;
      void this.runBatch(batch)
        .catch(() => undefined)
        .finally(() => {
          this.activeWorkers -= 1;
          void this.drain();
          if (this.pending.length === 0 && this.activeWorkers === 0) {
            const resolvers = this.idleResolvers;
            this.idleResolvers = [];
            for (const resolve of resolvers) resolve();
          }
        });
    }
  }

  /** 取一批：条数受 batchSize 约束、字符累计受 maxBatchChars 约束；未配置预算时与直接 splice 等价。 */
  private takeBatch(): T[] {
    const batch: T[] = [];
    let chars = 0;
    while (this.pending.length > 0 && batch.length < this.batchSize) {
      const item = this.pending[0];
      const size = this.itemChars ? this.itemChars(item) : 0;
      if (batch.length > 0 && this.maxBatchChars !== undefined && chars + size > this.maxBatchChars) break;
      batch.push(item);
      this.pending.shift();
      chars += size;
    }
    return batch;
  }
}
