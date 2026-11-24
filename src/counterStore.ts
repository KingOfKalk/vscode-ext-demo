const KEY = 'count';

export interface CountStorage {
  get(key: string): unknown;
  update(key: string, value: number): PromiseLike<void>;
}

/** The single source of truth for the count. Does not know about VS Code. */
export class CounterStore {
  private value: number;
  private readonly listeners = new Set<(count: number) => void>();
  // Saves run one after another, so the last write is always the latest count.
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: CountStorage,
    private readonly step: () => number,
  ) {
    const saved = storage.get(KEY);
    this.value = typeof saved === 'number' && Number.isInteger(saved) && saved >= 0 ? saved : 0;
  }

  get count(): number {
    return this.value;
  }

  /**
   * Changes the count and notifies the listeners synchronously, then saves.
   * Rejects if saving fails (the new count is kept) or if a listener threw: a
   * throwing listener never stops the other listeners or the save. With several
   * errors it rejects with an AggregateError, listener errors first.
   */
  increment(): Promise<void> {
    return this.set(this.value + this.step());
  }

  reset(): Promise<void> {
    return this.set(0);
  }

  onDidChange(listener: (count: number) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  private async set(next: number): Promise<void> {
    this.value = next;
    const errors: unknown[] = [];
    for (const listener of [...this.listeners]) {
      try {
        listener(next);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await this.save();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Several errors while changing the count');
    }
  }

  private save(): Promise<void> {
    // Writes the count as it is when its turn comes, never an outdated one.
    const run = this.tail.then(() => this.storage.update(KEY, this.value));
    this.tail = run.catch(() => undefined);
    return run;
  }
}
