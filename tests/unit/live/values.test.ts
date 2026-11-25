import { describe, expect, it } from 'vitest';
import {
  cutLines,
  foldStack,
  formatPrimitive,
  INSPECT,
  shorten,
  type InspectOptions,
} from '../../../scripts/live/values.ts';

describe('formatPrimitive', () => {
  it.each([
    [{ type: 'undefined' }, 'undefined'],
    [{ type: 'object', subtype: 'null', value: null }, 'null'],
    [{ type: 'number', value: 2, description: '2' }, '2'],
    [{ type: 'number', unserializableValue: 'NaN', description: 'NaN' }, 'NaN'],
    [{ type: 'number', unserializableValue: '-0', description: '-0' }, '-0'],
    [{ type: 'number', unserializableValue: '-Infinity' }, '-Infinity'],
    [{ type: 'bigint', unserializableValue: '10n', description: '10n' }, '10n'],
    [{ type: 'boolean', value: false }, 'false'],
    [{ type: 'string', value: '' }, "''"],
    [{ type: 'string', value: "it's" }, `"it's"`],
    [{ type: 'string', value: 'a\nb' }, "'a\\nb'"],
  ])('%j', (value, text) => {
    expect(formatPrimitive(value)).toBe(text);
  });

  it.each([
    [{ type: 'object', className: 'Object', description: 'Object', objectId: '1' }],
    [{ type: 'function', description: 'f() {}', objectId: '1' }],
    [{ type: 'symbol', description: 'Symbol(a)', objectId: '1' }],
  ])('leaves %j, which lives in the extension host', (value) => {
    expect(formatPrimitive(value)).toBeUndefined();
  });
});

describe('INSPECT', () => {
  // What the extension host runs, with the value as `this`.
  const inspect = (0, eval)(`(${INSPECT})`) as (this: unknown, options: InspectOptions) => string;
  const show = (value: unknown, depth = 2, width = 80) => inspect.call(value, { depth, width });

  it('shows objects like they are written, down to a depth', () => {
    expect(show({ a: 1, b: ['x'], c: { d: { e: {} } } })).toBe(
      "{ a: 1, b: [ 'x' ], c: { d: { e: {} } } }",
    );
    expect(show({ a: { b: { c: 1 } } }, 1)).toBe('{ a: { b: [Object] } }');
    expect(show({ a: { b: 1 }, list: [[1]] }, 0)).toBe('{ a: [Object], list: [Array] }');
  });

  it('shows circles, maps, sets, classes, functions and symbols', () => {
    class Box {
      size = 1;
    }
    const circle: Record<string, unknown> = { box: new Box() };
    circle.self = circle;
    expect(show(circle)).toBe('<ref *1> { box: Box { size: 1 }, self: [Circular *1] }');
    expect(show(new Map([['a', new Set([1])]]))).toBe("Map(1) { 'a' => Set(1) { 1 } }");
    expect(show(function name() {})).toBe('[Function: name]');
    expect(show(Symbol('a'))).toBe('Symbol(a)');
  });

  it('runs no getter, no toJSON, no custom inspection and no trap of a proxy', () => {
    const run = () => {
      throw new Error('ran');
    };
    const value = {
      get a(): number {
        return run();
      },
      toJSON: run,
      [Symbol.for('nodejs.util.inspect.custom')]: run,
      p: new Proxy({}, { get: run, ownKeys: run, getPrototypeOf: run }),
    };
    expect(show(value, 1, 1000)).toContain('a: [Getter]');
  });

  it('cuts long lists and texts', () => {
    const text = show({ list: Array.from({ length: 500 }, () => 0), s: 'y'.repeat(50_000) });
    expect(text).toContain('more items');
    expect(text.length).toBeLessThan(5000);
  });

  it('stays in one line with no width', () => {
    const wide = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`key${i}`, 'value']));
    expect(show(wide, 1, Infinity)).not.toContain('\n');
    expect(show(wide)).toContain('\n');
  });

  it('shows the stack of an error', () => {
    expect(show(new Error('boom'))).toMatch(/^Error: boom\n {4}at /);
  });
});

describe('shorten', () => {
  it.each([
    ['short', 10, 'short'],
    ['a\n  b\n\tc', 10, 'a b c'],
    ['0123456789', 10, '0123456789'],
    ['0123456789x', 10, '012345678…'],
  ])('%j', (text, max, short) => {
    expect(shorten(text, max)).toBe(short);
  });
});

describe('cutLines', () => {
  it('says how many lines are left out', () => {
    expect(cutLines('a\nb\nc', 3)).toBe('a\nb\nc');
    expect(cutLines('a\nb\nc\nd', 2)).toBe('a\nb\n… 2 more lines');
    expect(cutLines('a\nb\nc', 2)).toBe('a\nb\n… 1 more line');
  });

  it('cuts a line that is too long', () => {
    expect(cutLines('x'.repeat(20), 5, 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('foldStack', () => {
  it('counts the frames of VS Code, Node and Electron', () => {
    expect(
      foldStack(
        [
          'Error: boom',
          '\tat grow (src/counter.ts:21:5)',
          '\tat E.fire (file:///x/out/vs/workbench/api/node/extensionHostProcess.js:28:3962)',
          '\tat MessagePortMain.emit (node:events:514:28)',
          '    at node:internal/main:1:2',
          '\tat start (src/counter.ts:1:1)',
          '    at async file:///x/extensionHostProcess.js:28:3962 {',
          "  code: 'X'",
          '}',
        ].join('\n'),
      ),
    ).toBe(
      [
        'Error: boom',
        '    at grow (src/counter.ts:21:5)',
        '    … 3 frames of VS Code or Node',
        '    at start (src/counter.ts:1:1)',
        '    … 1 frame of VS Code or Node {',
        "  code: 'X'",
        '}',
      ].join('\n'),
    );
  });

  it('leaves other text', () => {
    const text = 'look at node:fs\n  at home\nextensionHostProcess.js';
    expect(foldStack(text)).toBe(text);
  });
});
