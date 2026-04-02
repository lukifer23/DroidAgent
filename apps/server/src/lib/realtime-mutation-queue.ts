export type RealtimeMutationLoad = <T>(
  key: string,
  loader: () => Promise<T>,
) => Promise<T>;

export interface RealtimeMutationSpec<Event, Slice extends string> {
  slices?: Slice[];
  startup?: boolean;
  build: (load: RealtimeMutationLoad) => Promise<Event | Event[]>;
}

export class RealtimeMutationQueue<Event, Slice extends string> {
  private pending: {
    slices: Set<Slice>;
    startup: boolean;
    specs: Array<RealtimeMutationSpec<Event, Slice>>;
  } | null = null;
  private draining = false;
  private drainPromise: Promise<void> | null = null;
  private reentrantDrainAllowed = false;

  constructor(
    private readonly options: {
      invalidate: (slices: Slice[], options: { startup: boolean }) => void;
      emit: (event: Event) => void | Promise<void>;
    },
  ) {}

  enqueue(spec: RealtimeMutationSpec<Event, Slice>): Promise<void> {
    if (!this.pending) {
      this.pending = {
        slices: new Set<Slice>(),
        startup: false,
        specs: [],
      };
    }
    for (const slice of spec.slices ?? []) {
      this.pending.slices.add(slice);
    }
    this.pending.startup ||= spec.startup === true;
    this.pending.specs.push(spec);

    if (!this.draining) {
      this.draining = true;
      this.drainPromise = Promise.resolve()
        .then(async () => this.drain())
        .finally(() => {
          this.draining = false;
          this.drainPromise = null;
        });
    } else if (this.reentrantDrainAllowed) {
      return this.drain();
    }

    return this.drainPromise ?? Promise.resolve();
  }

  private async drain(): Promise<void> {
    while (this.pending) {
      const batch = this.pending;
      this.pending = null;
      this.options.invalidate([...batch.slices], {
        startup: batch.startup,
      });

      const loads = new Map<string, Promise<unknown>>();
      const load: RealtimeMutationLoad = async <T>(
        key: string,
        loader: () => Promise<T>,
      ): Promise<T> => {
        const existing = loads.get(key) as Promise<T> | undefined;
        if (existing) {
          return await existing;
        }
        const next = loader();
        loads.set(key, next);
        return await next;
      };

      for (const spec of batch.specs) {
        const built = await spec.build(load);
        const events = Array.isArray(built) ? built : [built];
        for (const event of events) {
          this.reentrantDrainAllowed = true;
          try {
            await this.options.emit(event);
          } finally {
            this.reentrantDrainAllowed = false;
          }
        }
      }
    }
  }
}
