import { describe, expect, it } from 'vitest';
import { parseToExtension, parseToWebview } from '../../src/protocol';

describe('parseToExtension', () => {
  it.each(['ready', 'increment', 'reset'])('accepts %s', (type) => {
    expect(parseToExtension({ type })).toEqual({ type });
  });

  it('drops extra fields', () => {
    expect(parseToExtension({ type: 'increment', by: 5 })).toEqual({ type: 'increment' });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'increment'],
    ['a number', 1],
    ['an array', ['increment']],
    ['an empty object', {}],
    ['an unknown type', { type: 'nope' }],
    ['a non-string type', { type: 1 }],
    ['an inherited type name', { type: 'toString' }],
  ])('rejects %s', (_name, value) => {
    expect(parseToExtension(value)).toBeUndefined();
  });
});

describe('parseToWebview', () => {
  it('accepts a state message', () => {
    expect(parseToWebview({ type: 'state', count: 3, message: 'Hi' })).toEqual({
      type: 'state',
      count: 3,
      message: 'Hi',
    });
  });

  it('accepts zero and an empty message', () => {
    expect(parseToWebview({ type: 'state', count: 0, message: '' })).toEqual({
      type: 'state',
      count: 0,
      message: '',
    });
  });

  it.each([
    ['null', null],
    ['a string', 'state'],
    ['an unknown type', { type: 'nope', count: 1, message: 'm' }],
    ['a missing count', { type: 'state', message: 'm' }],
    ['a missing message', { type: 'state', count: 1 }],
    ['a string count', { type: 'state', count: '1', message: 'm' }],
    ['NaN', { type: 'state', count: NaN, message: 'm' }],
    ['a negative count', { type: 'state', count: -1, message: 'm' }],
    ['a fractional count', { type: 'state', count: 1.5, message: 'm' }],
    ['a non-string message', { type: 'state', count: 1, message: 5 }],
  ])('rejects %s', (_name, value) => {
    expect(parseToWebview(value)).toBeUndefined();
  });
});
