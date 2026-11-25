import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActionError } from '../../../scripts/live/errors.ts';
import { mapStackText, toGenerated, toSource } from '../../../scripts/live/sourceMap.ts';

const COUNTER = `// A comment.
import { twice } from './math/twice';

export interface Shape {
  count: number;
}

export class Counter {
  private value = 1; /* a field */

  get count(): number {
    return this.value;
  }

  // Doubles the value.
  async grow(by: () => number): Promise<void> {
    const next: number =
      twice(this.value) +
      by();
    await Promise.resolve();
    this.value = next;
  }
}
`;

const FILES = {
  'src/main.ts': `import { Counter } from './counter';\nimport type { Only } from './only';\nexport const start = (it?: Only) => new Counter().grow(() => it?.n ?? 3);\n`,
  'src/counter.ts': COUNTER,
  'src/math/twice.ts': 'export function twice(n: number): number {\n  return n * 2;\n}\n',
  'src/only.ts': 'export interface Only {\n  n: number;\n}\n',
};

const root = mkdtempSync(join(tmpdir(), 'source-map-'));
let map: object;
let lines: string[];

beforeAll(async () => {
  for (const [file, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  // The options of esbuild.mjs.
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['src/main.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    bundle: true,
    sourcemap: 'linked',
    write: false,
  });
  const text = (name: string) =>
    result.outputFiles.find(({ path }) => path.endsWith(name))?.text ?? '';
  map = JSON.parse(text('.map')) as object;
  lines = text('extension.js').split('\n');
});

afterAll(() => {
  rmSync(root, { recursive: true });
});

/** What the bundle has from the generated position of a line on. */
function codeAt(file: string, line: number): string {
  const { line: at, column } = toGenerated(map, file, line);
  return lines[at]?.slice(column).trimStart() ?? '';
}

describe('toGenerated', () => {
  it.each([
    ['src/counter.ts', 9, 'value = 1'],
    ['src/counter.ts', 12, 'return this.value;'],
    ['src/counter.ts', 16, 'async grow(by) {'],
    // TypeScript breaks the line, the bundle does not.
    ['src/counter.ts', 18, 'twice(this.value) + by();'],
    ['src/counter.ts', 19, 'by();'],
    ['src/counter.ts', 20, 'await Promise.resolve();'],
    ['src/counter.ts', 21, 'this.value = next;'],
    ['src/math/twice.ts', 2, 'return n * 2;'],
    ['./src/counter.ts', 20, 'await Promise.resolve();'],
    ['src/math/../counter.ts', 20, 'await Promise.resolve();'],
  ])('maps %s:%i', (file, line, code) => {
    expect(codeAt(file, line).startsWith(code), codeAt(file, line)).toBe(true);
  });

  it.each([
    [1, 'a comment'],
    [4, 'an interface'],
    [5, 'a type'],
    [7, 'an empty line'],
    [15, 'a comment in a class'],
    [999, 'after the end'],
  ])('throws for line %i, %s', (line) => {
    expect(() => toGenerated(map, 'src/counter.ts', line)).toThrow(ActionError);
    expect(() => toGenerated(map, 'src/counter.ts', line)).toThrow(
      `src/counter.ts:${line} has no code`,
    );
  });

  it('names the lines with code around a line without', () => {
    expect(() => toGenerated(map, 'src/counter.ts', 15)).toThrow('have code: 13, 16');
    expect(() => toGenerated(map, 'src/counter.ts', 1)).toThrow('have code: 8');
    expect(() => toGenerated(map, 'src/counter.ts', 999)).toThrow('have code: 23');
  });

  it.each(['src/nope.ts', 'counter.ts', 'src/only.ts', 'src', 'src/Counter.ts'])(
    'throws for %s, which is not in the bundle, and lists what is',
    (file) => {
      expect(() => toGenerated(map, file, 1)).toThrow(ActionError);
      expect(() => toGenerated(map, file, 1)).toThrow(
        /is not in the bundle .*src\/counter\.ts, src\/main\.ts, src\/math\/twice\.ts/s,
      );
    },
  );

  it('throws for code of the window', () => {
    expect(() => toGenerated(map, 'src/webview/main.ts', 1)).toThrow('runs in the Demo window');
  });
});

describe('toSource', () => {
  it.each([
    ['src/counter.ts', 12],
    ['src/counter.ts', 19],
    ['src/counter.ts', 21],
    ['src/math/twice.ts', 2],
  ])('maps the generated position of %s:%i back', (file, line) => {
    const generated = toGenerated(map, file, line);
    expect(toSource(map, generated.line, generated.column)).toMatchObject({ file, line });
  });

  it('counts lines and columns from 1, like an editor', () => {
    const at = lines.findIndex((line) => line.includes('this.value = next'));
    const column = lines[at]?.indexOf('this.value') ?? 0;
    expect(toSource(map, at, column)).toEqual({ file: 'src/counter.ts', line: 21, column: 5 });
    // Within a name: the position of what it belongs to.
    expect(toSource(map, at, column + 2)).toEqual({ file: 'src/counter.ts', line: 21, column: 5 });
  });

  it('is undefined for lines that esbuild added, and outside of the bundle', () => {
    const helper = lines.findIndex((line) => line.startsWith('var __defProp'));
    expect(toSource(map, helper, 0)).toBeUndefined();
    expect(toSource(map, lines.length + 5, 0)).toBeUndefined();
  });
});

describe('mapStackText', () => {
  const bundle = '/x/extensions/k.demo-0.0.0/dist/extension.js';

  it('maps the positions of the bundle and leaves the rest', () => {
    const at = lines.findIndex((line) => line.includes('this.value = next'));
    const column = (lines[at]?.indexOf('this.value') ?? 0) + 1;
    const text = [
      'Error: boom',
      `    at grow (${bundle}:${at + 1}:${column})`,
      `    at file://${bundle}:${at + 1}:${column}`,
      `    at helper (${bundle}:1:1)`,
      '    at other (/x/other/dist/extension.js:21:5)',
      '    at node:events:1:2',
    ].join('\n');
    expect(mapStackText(text, map, bundle)).toBe(
      [
        'Error: boom',
        '    at grow (src/counter.ts:21:5)',
        '    at src/counter.ts:21:5',
        `    at helper (${bundle}:1:1)`,
        '    at other (/x/other/dist/extension.js:21:5)',
        '    at node:events:1:2',
      ].join('\n'),
    );
  });
});
