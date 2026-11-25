import { describe, expect, it } from 'vitest';
import { readSettings, type Settings } from '../../src/settings';

/** A `get` that returns the given values and `undefined` for everything else. */
function getter(values: Partial<Record<keyof Settings, unknown>>) {
  return (key: keyof Settings): unknown => values[key];
}

describe('readSettings', () => {
  it('uses the defaults when nothing is set', () => {
    expect(readSettings(getter({}))).toEqual({
      message: 'Hello from kingofkalk!',
      step: 1,
      showStatusBar: true,
      openLocation: 'tab',
    });
  });

  it('passes valid values through', () => {
    expect(
      readSettings(
        getter({ message: 'Hi', step: 7, showStatusBar: false, openLocation: 'beside' }),
      ),
    ).toEqual({ message: 'Hi', step: 7, showStatusBar: false, openLocation: 'beside' });
  });

  it('keeps an empty message', () => {
    expect(readSettings(getter({ message: '' })).message).toBe('');
  });

  it.each([undefined, null, 5, {}, true])('uses the default message for %j', (value) => {
    expect(readSettings(getter({ message: value })).message).toBe('Hello from kingofkalk!');
  });

  it.each([
    ['a numeric string', '5', 1],
    ['zero', 0, 1],
    ['a negative number', -3, 1],
    ['a fraction', 1.5, 1],
    ['NaN', NaN, 1],
    ['Infinity', Infinity, 1],
    ['null', null, 1],
    ['undefined', undefined, 1],
    ['the lower bound', 1, 1],
    ['a valid step', 7, 7],
    ['the upper bound', 100, 100],
    ['a step above the range', 1000, 100],
  ])('reads step %s', (_name, value, expected) => {
    expect(readSettings(getter({ step: value })).step).toBe(expected);
  });

  it.each([undefined, null, 'false', 0, 1])('uses true for showStatusBar %j', (value) => {
    expect(readSettings(getter({ showStatusBar: value })).showStatusBar).toBe(true);
  });

  it('reads showStatusBar false', () => {
    expect(readSettings(getter({ showStatusBar: false })).showStatusBar).toBe(false);
  });

  it.each([undefined, null, 'window', 'BESIDE', 1])('uses tab for openLocation %j', (value) => {
    expect(readSettings(getter({ openLocation: value })).openLocation).toBe('tab');
  });

  it('reads openLocation beside', () => {
    expect(readSettings(getter({ openLocation: 'beside' })).openLocation).toBe('beside');
  });
});
