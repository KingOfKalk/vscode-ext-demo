import { describe, expect, it } from 'vitest';
import { oneLine } from '../../../scripts/live/interact.ts';

describe('oneLine', () => {
  it('keeps the first line of an error', () => {
    expect(oneLine(new Error('locator.click: Timeout 5000ms exceeded.'))).toBe(
      'locator.click: Timeout 5000ms exceeded.',
    );
  });

  it('adds what Playwright was waiting for, the last line of its log', () => {
    const error = new Error(
      [
        'locator.click: Timeout 5000ms exceeded.',
        'Call log:',
        '  - waiting for getByRole("button")',
        '  - element is not visible',
      ].join('\n'),
    );
    expect(oneLine(error)).toBe('locator.click: Timeout 5000ms exceeded. (element is not visible)');
  });

  it('takes other values as text', () => {
    expect(oneLine('plain')).toBe('plain');
  });
});
