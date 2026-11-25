import { describe, expect, it } from 'vitest';
import { ActionError, guard, oneLine, userError } from '../../../scripts/live/errors.ts';

const PLAYWRIGHT = new Error(
  [
    'locator.click: Timeout 5000ms exceeded.',
    'Call log:',
    '  - waiting for getByRole("button")',
    '  - element is not visible',
  ].join('\n'),
);

describe('oneLine', () => {
  it('keeps the first line of an error', () => {
    expect(oneLine(new Error('locator.click: Timeout 5000ms exceeded.'))).toBe(
      'locator.click: Timeout 5000ms exceeded.',
    );
  });

  it('adds what Playwright was waiting for, the last line of its log', () => {
    expect(oneLine(PLAYWRIGHT)).toBe(
      'locator.click: Timeout 5000ms exceeded. (element is not visible)',
    );
  });

  it('takes other values as text', () => {
    expect(oneLine('plain')).toBe('plain');
  });
});

describe('userError and guard', () => {
  it('leaves an ActionError, which may have many lines, as it is', () => {
    const error = new ActionError('a\nb');
    expect(userError(error, 'x')).toBe(error);
  });

  it('cuts anything else to one line, without a cause', () => {
    const error = userError(PLAYWRIGHT, 'cannot read the window');
    expect(error).toBeInstanceOf(ActionError);
    expect(error.message).toBe(
      'cannot read the window: locator.click: Timeout 5000ms exceeded. (element is not visible)',
    );
    expect(error.cause).toBeUndefined();
    expect(error.message).not.toContain('Call log');
  });

  it('guard passes the value and turns a failure into one line', async () => {
    await expect(guard('x', () => Promise.resolve(3))).resolves.toBe(3);
    await expect(guard('cannot count', () => Promise.reject(PLAYWRIGHT))).rejects.toThrow(
      /^cannot count: locator\.click: Timeout 5000ms exceeded\. \(element is not visible\)$/,
    );
  });
});
