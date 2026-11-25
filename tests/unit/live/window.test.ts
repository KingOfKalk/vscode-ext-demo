import { describe, expect, it } from 'vitest';
import type { LiveCommand } from '../../../scripts/live/args.ts';
import { ActionError } from '../../../scripts/live/errors.ts';
import { onWindow, type WindowCommand } from '../../../scripts/live/window.ts';
import type { Connection } from '../../../scripts/live/vscode.ts';

describe('onWindow', () => {
  it('throws, and does not return undefined, for a command that is not in the table', async () => {
    const stray = { name: 'logs' } as unknown as WindowCommand;
    const never = () => Promise.reject(new Error('not reached'));
    await expect(onWindow(stray, never)).rejects.toThrow('logs is not a window command');
  });

  it('closes the connection and cuts what Playwright says to a line', async () => {
    let closed = false;
    const connection = {
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    } as unknown as Connection;
    const command: LiveCommand = { name: 'key', combo: 'Enter' };
    const actions = { key: () => Promise.reject(new Error('boom\nCall log:\n  - waiting')) };
    const failure = await onWindow(
      command as WindowCommand,
      () => Promise.resolve(connection),
      actions,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ActionError);
    expect((failure as ActionError).message).toBe('boom (waiting)');
    expect(closed).toBe(true);
  });

  it('reports a failed connection as one line', async () => {
    await expect(
      onWindow({ name: 'snapshot' }, () =>
        Promise.reject(new Error('no live session runs\nCall log:\n  - waiting')),
      ),
    ).rejects.toThrow(new ActionError('no live session runs (waiting)'));
  });
});
