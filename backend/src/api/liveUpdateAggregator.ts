export type LiveUpdateAggregatorOptions = {
  flushIntervalMs: number;
  maxKeys: number;
  onFlush: () => void;
  onDropKey?: (key: string, size: number) => void;
};

export class LiveUpdateAggregator {
  private readonly pendingByKey = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private warnedDrop = false;

  constructor(private readonly options: LiveUpdateAggregatorOptions) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.pendingByKey.size === 0) return;
      this.pendingByKey.clear();
      this.options.onFlush();
    }, this.options.flushIntervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.pendingByKey.clear();
    this.warnedDrop = false;
  }

  upsert(key: string) {
    if (!key) return;
    if (this.pendingByKey.has(key)) {
      this.pendingByKey.set(key, Date.now());
      return;
    }
    if (this.pendingByKey.size >= this.options.maxKeys) {
      if (!this.warnedDrop) {
        this.warnedDrop = true;
        this.options.onDropKey?.(key, this.pendingByKey.size);
      }
      return;
    }
    this.pendingByKey.set(key, Date.now());
  }
}
