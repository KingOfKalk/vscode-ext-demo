import { describe, expect, it, vi } from 'vitest';
import { CounterStore, type CountStorage } from '../../src/counterStore';

class FakeStorage implements CountStorage {
  readonly saved: number[] = [];
  constructor(private readonly initial: unknown = undefined) {}
  get(key: string): unknown {
    return key === 'count' ? this.initial : undefined;
  }
  update(key: string, value: number): PromiseLike<void> {
    expect(key).toBe('count');
    this.saved.push(value);
    return Promise.resolve();
  }
}

describe('CounterStore', () => {
  it('starts with the saved count', () => {
    const store = new CounterStore(new FakeStorage(7), () => 1);
    expect(store.count).toBe(7);
  });

  it.each([undefined, 'x', NaN, -1, 1.5, null, 1e300, 2 ** 53, Infinity])(
    'starts at 0 for the saved value %j',
    (saved) => {
      const store = new CounterStore(new FakeStorage(saved), () => 1);
      expect(store.count).toBe(0);
    },
  );

  it('adds the step read at the moment of the increment', async () => {
    let step = 1;
    const store = new CounterStore(new FakeStorage(), () => step);
    await store.increment();
    step = 5;
    await store.increment();
    expect(store.count).toBe(6);
  });

  it('subtracts the step read at the moment of the decrement', async () => {
    let step = 1;
    const storage = new FakeStorage(10);
    const store = new CounterStore(storage, () => step);
    await store.decrement();
    step = 5;
    await store.decrement();
    expect(store.count).toBe(4);
    expect(storage.saved).toEqual([9, 4]);
  });

  it.each([
    [0, 1],
    [3, 5],
    [5, 5],
  ])('never goes below 0: from %j with step %j', async (count, step) => {
    const storage = new FakeStorage(count);
    const store = new CounterStore(storage, () => step);
    const listener = vi.fn();
    store.onDidChange(listener);
    await store.decrement();
    expect(store.count).toBe(0);
    expect(listener).toHaveBeenCalledExactlyOnceWith(0);
    expect(storage.saved).toEqual([0]);
  });

  it('ends at 0 after more decrements than the count, without await', async () => {
    const storage = new FakeStorage(3);
    const store = new CounterStore(storage, () => 1);
    const results = Array.from({ length: 10 }, () => store.decrement());
    expect(store.count).toBe(0);
    await Promise.all(results);
    expect(storage.saved.at(-1)).toBe(0);
    await store.increment();
    expect(store.count).toBe(1);
  });

  it('resets to 0', async () => {
    const store = new CounterStore(new FakeStorage(4), () => 1);
    await store.reset();
    expect(store.count).toBe(0);
  });

  it('saves after increment and reset', async () => {
    const storage = new FakeStorage();
    const store = new CounterStore(storage, () => 2);
    await store.increment();
    await store.increment();
    await store.reset();
    expect(storage.saved.at(-1)).toBe(0);
    expect(storage.saved).toContain(4);
  });

  it('changes and notifies synchronously, before the save is done', () => {
    const store = new CounterStore(new FakeStorage(), () => 1);
    const listener = vi.fn();
    store.onDidChange(listener);
    void store.increment();
    expect(store.count).toBe(1);
    expect(listener).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('gives a listener each new count and nothing after dispose', async () => {
    const store = new CounterStore(new FakeStorage(), () => 1);
    const listener = vi.fn();
    const subscription = store.onDidChange(listener);
    await store.increment();
    await store.increment();
    await store.reset();
    expect(listener.mock.calls).toEqual([[1], [2], [0]]);
    subscription.dispose();
    subscription.dispose();
    await store.increment();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('lets a listener dispose itself while being notified', async () => {
    const store = new CounterStore(new FakeStorage(), () => 1);
    const other = vi.fn();
    const subscription = store.onDidChange(() => subscription.dispose());
    store.onDidChange(other);
    await store.increment();
    await store.increment();
    expect(other.mock.calls).toEqual([[1], [2]]);
  });

  it('ends at 10 and saves 10 last after 10 increments without await', async () => {
    const storage = new FakeStorage();
    const store = new CounterStore(storage, () => 1);
    const results = Array.from({ length: 10 }, () => store.increment());
    expect(store.count).toBe(10);
    await Promise.all(results);
    expect(storage.saved.at(-1)).toBe(10);
  });

  it('saves 10 last even if an earlier update resolves later', async () => {
    const resolvers: (() => void)[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const saved: number[] = [];
    const storage: CountStorage = {
      get: () => undefined,
      update: (_key, value) => {
        saved.push(value);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<void>((resolve) => {
          resolvers.push(() => {
            inFlight--;
            resolve();
          });
        });
      },
    };
    const store = new CounterStore(storage, () => 1);
    const results = Array.from({ length: 10 }, () => store.increment());
    // Every update resolves only after a macrotask, so each one is as late as possible.
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(resolvers).toHaveLength(1);
      resolvers.shift()?.();
    }
    await Promise.all(results);
    expect(saved).toHaveLength(10);
    expect(saved.at(-1)).toBe(10);
    expect(maxInFlight).toBe(1);
  });

  it('keeps the new count and rejects when saving fails', async () => {
    const failure = new Error('disk full');
    const storage: CountStorage = {
      get: () => 3,
      update: () => Promise.reject(failure),
    };
    const store = new CounterStore(storage, () => 1);
    const listener = vi.fn();
    store.onDidChange(listener);
    await expect(store.increment()).rejects.toBe(failure);
    expect(store.count).toBe(4);
    expect(listener).toHaveBeenCalledWith(4);
    await expect(store.reset()).rejects.toBe(failure);
    expect(store.count).toBe(0);
  });

  it('keeps saving after an earlier save failed', async () => {
    const saved: number[] = [];
    let fail = true;
    const storage: CountStorage = {
      get: () => undefined,
      update: (_key, value) => {
        saved.push(value);
        return fail ? Promise.reject(new Error('first fails')) : Promise.resolve();
      },
    };
    const store = new CounterStore(storage, () => 1);
    await expect(store.increment()).rejects.toThrow('first fails');
    fail = false;
    await store.increment();
    expect(saved).toEqual([1, 2]);
  });

  it('rejects when update throws synchronously', async () => {
    const storage: CountStorage = {
      get: () => undefined,
      update: () => {
        throw new Error('sync failure');
      },
    };
    const store = new CounterStore(storage, () => 1);
    await expect(store.increment()).rejects.toThrow('sync failure');
    expect(store.count).toBe(1);
  });

  describe('a listener that throws', () => {
    it('does not stop the other listeners or the save, and rejects with its error', async () => {
      const storage = new FakeStorage();
      const store = new CounterStore(storage, () => 1);
      const before = vi.fn();
      const after = vi.fn();
      const boom = new Error('listener failed');
      store.onDidChange(before);
      store.onDidChange(() => {
        throw boom;
      });
      store.onDidChange(after);
      await expect(store.increment()).rejects.toBe(boom);
      expect(before).toHaveBeenCalledWith(1);
      expect(after).toHaveBeenCalledWith(1);
      expect(storage.saved).toEqual([1]);
      expect(store.count).toBe(1);
    });

    it('reports every error when several listeners and the save fail', async () => {
      const listenerError = new Error('listener failed');
      const saveError = new Error('save failed');
      const storage: CountStorage = {
        get: () => undefined,
        update: () => Promise.reject(saveError),
      };
      const store = new CounterStore(storage, () => 1);
      store.onDidChange(() => {
        throw listenerError;
      });
      const error: unknown = await store.increment().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([listenerError, saveError]);
    });
  });
});
