export class TtlCache<T> {
  private value: T | null = null;
  private expiresAt = 0;
  private pending: Promise<T> | null = null;

  constructor(private readonly ttlMs: number) {}

  invalidate(): void {
    this.value = null;
    this.expiresAt = 0;
    this.pending = null;
  }

  async get(load: () => Promise<T>, force = false): Promise<T> {
    const now = Date.now();
    if (!force && this.value !== null && now < this.expiresAt) {
      return this.value;
    }

    if (!force && this.pending) {
      return await this.pending;
    }

    const next = load()
      .then((value) => {
        this.value = value;
        this.expiresAt = Date.now() + this.ttlMs;
        return value;
      })
      .finally(() => {
        this.pending = null;
      });

    this.pending = next;
    return await next;
  }
}
