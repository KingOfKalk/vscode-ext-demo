import { describe, expect, it } from 'vitest';
import {
  describeNoHit,
  describePlace,
  describeStack,
  formatReport,
  type RawFrame,
} from '../../../scripts/live/debug.ts';

/** Script 1 is the bundle; its line 7 is the code of esbuild. */
const locate = ({ scriptId, lineNumber, columnNumber }: RawFrame) => {
  if (scriptId !== '1') return undefined;
  return lineNumber === 7
    ? `dist/extension.js:8:${columnNumber + 1}`
    : `src/a.ts:${lineNumber + 1}:${columnNumber + 1}`;
};
const own = (functionName: string, lineNumber: number): RawFrame => ({
  functionName,
  scriptId: '1',
  lineNumber,
  columnNumber: 4,
});
const foreign: RawFrame = { functionName: 'x', scriptId: '9', lineNumber: 0, columnNumber: 0 };

describe('describeStack', () => {
  it('shows the frames of the extension and counts the others', () => {
    expect(
      describeStack(
        { frames: [own('grow', 2), own('', 30), foreign, foreign, own('start', 7), foreign] },
        locate,
      ),
    ).toEqual([
      'grow (src/a.ts:3:5)',
      '(anonymous) (src/a.ts:31:5)',
      '… 2 frames of VS Code or Node',
      'start (dist/extension.js:8:5)',
      '… 1 frame of VS Code or Node',
    ]);
  });

  it('goes on before an await, as long as the extension is in it', () => {
    expect(
      describeStack(
        {
          frames: [own('grow', 2)],
          parent: {
            description: 'await',
            frames: [own('start', 4), foreign],
            parent: { description: 'Promise.then', frames: [foreign] },
          },
        },
        locate,
      ),
    ).toEqual([
      'grow (src/a.ts:3:5)',
      '-- await --',
      'start (src/a.ts:5:5)',
      '… 1 frame of VS Code or Node',
    ]);
  });

  it('skips a part without the extension if there is one before it', () => {
    expect(
      describeStack(
        {
          frames: [own('grow', 2)],
          parent: { frames: [foreign], parent: { frames: [own('start', 4)] } },
        },
        locate,
      ),
    ).toEqual([
      'grow (src/a.ts:3:5)',
      '-- async --',
      '… 1 frame of VS Code or Node',
      '-- async --',
      'start (src/a.ts:5:5)',
    ]);
  });
});

describe('formatReport', () => {
  it('prints why, where, the locals and the expressions', () => {
    expect(
      formatReport({
        where: 'src/a.ts:3:5',
        reason: 'breakpoint',
        stack: ['grow (src/a.ts:3:5)'],
        frame: 'grow',
        locals: [
          { name: 'this', text: 'Counter { value: 0 }' },
          { name: 'next', text: '2' },
        ],
        moreLocals: 0,
        values: [
          { name: 'this.value', text: '0', outcome: 'value' },
          { name: 'this.x.y', text: 'TypeError: no\n    at grow', outcome: 'threw' },
          { name: '{a}', text: '{\n  a: 1\n}', outcome: 'value' },
          { name: 'late()', text: 'not evaluated', outcome: 'ended' },
        ],
      }),
    ).toBe(
      [
        'Paused at src/a.ts:3:5 (breakpoint)',
        'Stack:',
        '  grow (src/a.ts:3:5)',
        'Locals of grow:',
        '  this = Counter { value: 0 }',
        '  next = 2',
        'Evaluated:',
        '  this.value = 0',
        '  this.x.y threw TypeError: no',
        '      at grow',
        '  {a} = {',
        '    a: 1',
        '  }',
        '  late(): not evaluated',
      ].join('\n'),
    );
  });

  it('says how many locals are left out', () => {
    const text = formatReport({
      where: 'src/a.ts:3:5',
      reason: 'breakpoint',
      stack: [],
      frame: 'grow',
      locals: [{ name: 'a', text: '1' }],
      moreLocals: 2,
      values: [],
    });
    expect(text).toContain('  a = 1\n  … 2 more locals');
  });

  it('says that there are no locals, and has no empty part', () => {
    const text = formatReport({
      where: 'src/a.ts:3:5',
      reason: 'breakpoint',
      stack: ['grow (src/a.ts:3:5)'],
      frame: 'grow',
      locals: [],
      moreLocals: 0,
      values: [],
    });
    expect(text).toContain('Locals of grow: none');
    expect(text).not.toContain('Evaluated');
  });
});

describe('describePlace', () => {
  const generated = { line: 161, column: 16 };

  it('names the place in both files', () => {
    const place = { file: 'src/a.ts', line: 3, column: 12 };
    expect(describePlace('src/a.ts', 3, place, generated)).toBe(
      'src/a.ts:3:12 (dist/extension.js:162:17)',
    );
  });

  it('says when it is a later line', () => {
    const place = { file: 'src/a.ts', line: 4, column: 1 };
    expect(describePlace('src/a.ts', 3, place, generated)).toBe(
      'src/a.ts:4:1 (dist/extension.js:162:17, the next place to stop after line 3)',
    );
  });

  it.each([
    ['another file', { file: 'src/b.ts', line: 3, column: 1 }, 'src/b.ts:3:1'],
    ['an earlier line', { file: 'src/a.ts', line: 2, column: 1 }, 'src/a.ts:2:1'],
    ['the code of esbuild', undefined, 'dist/extension.js:162:17'],
  ])('refuses %s', (_, place, next) => {
    expect(() => describePlace('src/a.ts', 3, place, generated)).toThrow(
      `there is no place to stop at src/a.ts:3 or after it in its file (the next one is ${next})`,
    );
  });
});

describe('describeNoHit', () => {
  it('names the causes, among them a callback on the line of a call', () => {
    const text = describeNoHit('src/a.ts:3: no hit within 15 s', true);
    expect(text).toMatch(/^src\/a\.ts:3: no hit within 15 s\. The breakpoint is removed/);
    expect(text).toContain('what --do did does not lead there');
    expect(text).toContain('a callback that is on the same line as the call it is passed to');
    expect(describeNoHit('x', false)).toContain('pass a trigger with --do');
  });
});
