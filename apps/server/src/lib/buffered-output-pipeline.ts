type FlushCallback<Channel extends string> = (
  chunks: Array<{ channel: Channel; chunk: string }>,
) => Promise<void>;

export class BufferedOutputPipeline<Channel extends string> {
  private readonly pending = new Map<Channel, string>();
  private flushHandle: ReturnType<typeof setTimeout> | null = null;
  private flushQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      flushDelayMs: number;
      onFlush: FlushCallback<Channel>;
    },
  ) {}

  push(channel: Channel, chunk: string): void {
    if (!chunk) {
      return;
    }
    this.pending.set(channel, `${this.pending.get(channel) ?? ""}${chunk}`);
    this.scheduleFlush();
  }

  async close(): Promise<void> {
    await this.flushNow();
    await this.flushQueue;
  }

  async flush(): Promise<void> {
    await this.flushNow();
  }

  private scheduleFlush(): void {
    if (this.flushHandle) {
      return;
    }
    this.flushHandle = setTimeout(() => {
      this.flushHandle = null;
      void this.flushNow();
    }, this.options.flushDelayMs);
    this.flushHandle.unref?.();
  }

  private async flushNow(): Promise<void> {
    if (this.flushHandle) {
      clearTimeout(this.flushHandle);
      this.flushHandle = null;
    }
    if (this.pending.size === 0) {
      return;
    }
    const chunks = [...this.pending.entries()].map(([channel, chunk]) => ({
      channel,
      chunk,
    }));
    this.pending.clear();
    this.flushQueue = this.flushQueue
      .then(() => this.options.onFlush(chunks))
      .catch(() => {});
    await this.flushQueue;
  }
}
