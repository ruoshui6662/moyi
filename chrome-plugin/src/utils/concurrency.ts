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
  private pending: T[] = [];
  private activeWorkers = 0;
  private idleResolvers: (() => void)[] = [];

  constructor(options: {
    batchSize: number;
    concurrency: number;
    runBatch: (items: T[]) => Promise<void>;
  }) {
    this.batchSize = options.batchSize;
    this.concurrency = options.concurrency;
    this.runBatch = options.runBatch;
  }

  enqueue(items: T[]): void {
    this.pending.push(...items);
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
      const batch = this.pending.splice(0, this.batchSize);
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
}
