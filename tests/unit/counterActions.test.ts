import { describe, expect, it, vi } from 'vitest';
import { guarded } from '../../src/counterActions';

describe('guarded', () => {
  it('runs the action at once, before the first await', () => {
    const action = vi.fn(() => Promise.resolve());
    void guarded('increment', action, vi.fn());
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('reports nothing when the action succeeds', async () => {
    const report = vi.fn();
    await guarded('increment', () => Promise.resolve(), report);
    expect(report).not.toHaveBeenCalled();
  });

  it('reports a rejection with the name of the action, and itself resolves', async () => {
    const report = vi.fn();
    const error = new Error('save failed');
    await expect(guarded('reset', () => Promise.reject(error), report)).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledExactlyOnceWith('reset', error);
  });

  it('reports a synchronous throw too', async () => {
    const report = vi.fn();
    const error = new Error('step failed');
    await guarded(
      'increment',
      () => {
        throw error;
      },
      report,
    );
    expect(report).toHaveBeenCalledExactlyOnceWith('increment', error);
  });
});
