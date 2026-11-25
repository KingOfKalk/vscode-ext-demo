import { describe, expect, it } from 'vitest';
import { parseLiveArgs, splitWords, UsageError } from '../../../scripts/live/args.ts';

describe('parseLiveArgs', () => {
  it.each([
    [['start'], { name: 'start', keep: false }],
    [['start', '--keep'], { name: 'start', keep: true }],
    [['stop'], { name: 'stop' }],
    [['status'], { name: 'status' }],
    [['reload'], { name: 'reload' }],
    [['screenshot'], { name: 'screenshot', file: undefined }],
    [['screenshot', 'after-click_2'], { name: 'screenshot', file: 'after-click_2' }],
    [['snapshot'], { name: 'snapshot' }],
    [['click', 'Click me'], { name: 'click', target: 'Click me' }],
    [['type', 'two words'], { name: 'type', text: 'two words' }],
    [['type', '--keep'], { name: 'type', text: '--keep' }],
    [['key', 'Control+-'], { name: 'key', combo: 'Control+-' }],
    [['command', 'Demo: Open Window'], { name: 'command', title: 'Demo: Open Window' }],
    [
      ['set', 'vscodeExtDemo.message', '"Hi"'],
      { name: 'set', setting: 'vscodeExtDemo.message', value: 'Hi' },
    ],
    [
      ['set', 'vscodeExtDemo.step', 'null'],
      { name: 'set', setting: 'vscodeExtDemo.step', value: null },
    ],
    [['logs'], { name: 'logs' }],
    [
      ['break', 'src/counterStore.ts:12'],
      { name: 'break', file: 'src/counterStore.ts', line: 12, trigger: undefined, expressions: [] },
    ],
    [
      [
        'break',
        'src/counterStore.ts:12',
        '--do',
        'click "Click me"',
        '--eval',
        'this.count',
        '--eval=-1',
      ],
      {
        name: 'break',
        file: 'src/counterStore.ts',
        line: 12,
        trigger: { name: 'click', target: 'Click me' },
        expressions: ['this.count', '-1'],
      },
    ],
    [['eval', '1+1'], { name: 'eval', expression: '1+1' }],
    [['eval', '-1'], { name: 'eval', expression: '-1' }],
  ])('%j', (argv, command) => {
    expect(parseLiveArgs(argv)).toEqual(command);
  });

  it.each([
    [[], 'no command'],
    [['dance'], 'unknown command "dance"'],
    [['toString'], 'unknown command "toString"'],
    [['start', '--fresh'], "Unknown option '--fresh'"],
    [['start', 'now'], 'Unexpected argument'],
    [['stop', 'now'], 'stop takes no arguments'],
    [['screenshot', 'a', 'b'], 'screenshot [name]'],
    [['screenshot', '../a'], 'not a name'],
    [['screenshot', '.session'], 'not a name'],
    [['screenshot', 'a/b'], 'not a name'],
    [['click'], 'click <target>'],
    [['click', ''], 'click <target>'],
    [['click', 'Click', 'me'], 'quote it'],
    [['type'], 'type <text>'],
    [['key'], 'key <combo>'],
    [['command'], 'command <title>'],
    [['set', 'vscodeExtDemo.step'], 'set <setting> <json>'],
    [['set', 'vscodeExtDemo.message', 'Hi'], 'not JSON'],
    [['break'], 'break <file:line>'],
    [['break', 'src/counterStore.ts'], 'break <file:line>'],
    [['break', 'src/counterStore.ts:0'], 'break <file:line>'],
    [['break', ':3'], 'break <file:line>'],
    [['break', 'a.ts:1', 'b.ts:2'], 'break <file:line>'],
    [['break', 'a.ts:1', '--do'], '--do'],
    [['break', 'a.ts:1', '--do', 'dance'], 'unknown command "dance"'],
    [['break', 'a.ts:1', '--do', 'click "a'], 'quote'],
    [['break', 'a.ts:1', '--do', 'stop'], '--do cannot run stop'],
    [['break', 'a.ts:1', '--do', 'break b.ts:2'], '--do cannot run break'],
    [['eval'], 'eval <expr>'],
  ])('refuses %j', (argv, message) => {
    const parse = () => parseLiveArgs(argv);
    expect(parse).toThrow(UsageError);
    expect(parse).toThrow(message);
  });
});

describe('splitWords', () => {
  it.each([
    ['', []],
    ['  logs ', ['logs']],
    ['click "Click me"', ['click', 'Click me']],
    [`type 'a "b"'`, ['type', 'a "b"']],
    ['type "a \\"b\\" \\\\"', ['type', 'a "b" \\']],
    ['type ""', ['type', '']],
    ['click css=[id="count"]', ['click', 'css=[id="count"]']],
  ])('%j', (text, words) => {
    expect(splitWords(text)).toEqual(words);
  });

  it.each(['type "a', "type 'a", 'type "a"b'])('refuses %j', (text) => {
    expect(() => splitWords(text)).toThrow(UsageError);
  });
});
