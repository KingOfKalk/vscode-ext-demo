import { describe, expect, it } from 'vitest';
import { describeError, describeValue } from '../../src/describe';

describe('describeError', () => {
  it('uses the message of an Error', () => {
    expect(describeError(new Error('disk full'))).toBe('disk full');
  });

  it('lists every error of an AggregateError', () => {
    const error = new AggregateError([new Error('listener'), new Error('save')], 'Several');
    expect(describeError(error)).toBe('Several: listener; save');
  });

  it('describes values that are not errors', () => {
    expect(describeError('plain')).toBe('plain');
    expect(describeError(42)).toBe('42');
    expect(describeError(undefined)).toBe('undefined');
  });
});

describe('describeValue', () => {
  it('writes JSON', () => {
    expect(describeValue({ type: 'nope' })).toBe('{"type":"nope"}');
    expect(describeValue('x')).toBe('"x"');
  });

  it('cuts long values', () => {
    const text = describeValue('a'.repeat(500), 20);
    expect(text).toHaveLength(21);
    expect(text.endsWith('…')).toBe(true);
  });

  it('never throws', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => describeValue(circular)).not.toThrow();
    expect(describeValue(undefined)).toBe('undefined');
    expect(describeValue(() => 1)).toEqual(expect.any(String));
    expect(describeValue(1n)).toBe('1');
  });
});
