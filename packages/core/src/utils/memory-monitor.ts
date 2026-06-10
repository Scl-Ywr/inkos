export interface MemoryUsage {
  readonly heapUsed: number;
  readonly heapTotal: number;
  readonly external: number;
  readonly rss: number;
}

export interface MemoryThresholds {
  readonly heapUsedMB: number;
  readonly rssMB: number;
}

const DEFAULT_THRESHOLDS: MemoryThresholds = {
  heapUsedMB: 1024,
  rssMB: 2048,
};

export function getMemoryUsage(): MemoryUsage {
  const usage = process.memoryUsage();
  return {
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    rss: usage.rss,
  };
}

export function checkMemoryThreshold(thresholds: Partial<MemoryThresholds> = {}): { exceeded: boolean; message?: string } {
  const usage = getMemoryUsage();
  const limits = { ...DEFAULT_THRESHOLDS, ...thresholds };

  const heapUsedMB = usage.heapUsed / 1024 / 1024;
  const rssMB = usage.rss / 1024 / 1024;

  if (heapUsedMB > limits.heapUsedMB) {
    return {
      exceeded: true,
      message: `堆内存使用 ${heapUsedMB.toFixed(0)} MB 超过阈值 ${limits.heapUsedMB} MB`,
    };
  }

  if (rssMB > limits.rssMB) {
    return {
      exceeded: true,
      message: `常驻内存 ${rssMB.toFixed(0)} MB 超过阈值 ${limits.rssMB} MB`,
    };
  }

  return { exceeded: false };
}

export function formatMemoryUsage(usage: MemoryUsage): string {
  const heapUsedMB = (usage.heapUsed / 1024 / 1024).toFixed(0);
  const heapTotalMB = (usage.heapTotal / 1024 / 1024).toFixed(0);
  const rssMB = (usage.rss / 1024 / 1024).toFixed(0);
  return `堆内存: ${heapUsedMB}/${heapTotalMB} MB, 常驻: ${rssMB} MB`;
}

export function triggerGC(): void {
  if (global.gc) {
    global.gc();
  }
}
