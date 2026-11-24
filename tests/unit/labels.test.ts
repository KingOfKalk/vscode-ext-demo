import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../../src/ids';
import { actionRows, helloText, statusBarText } from '../../src/labels';

describe('statusBarText', () => {
  it('shows the dashboard icon and the count', () => {
    expect(statusBarText(0)).toBe('$(dashboard) Demo: 0');
    expect(statusBarText(12)).toBe('$(dashboard) Demo: 12');
  });
});

describe('actionRows', () => {
  const rows = actionRows(3);

  it('lists the three actions, then the counter', () => {
    expect(rows.map((r) => r.label)).toEqual([
      'Open window',
      'Say hello',
      'Show log',
      'Counter: 3',
    ]);
  });

  it('runs the matching command for each action, and none for the counter', () => {
    expect(rows.map((r) => r.command)).toEqual([
      COMMANDS.openWindow,
      COMMANDS.sayHello,
      COMMANDS.showLog,
      undefined,
    ]);
  });

  it('gives every row its own id and an icon', () => {
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    for (const row of rows) {
      expect(row.icon).not.toBe('');
    }
  });

  it('keeps the counter row id when the count changes', () => {
    expect(actionRows(4).at(-1)?.id).toBe(rows.at(-1)?.id);
    expect(actionRows(4).at(-1)?.label).toBe('Counter: 4');
  });
});

describe('helloText', () => {
  it('shows the message as it is', () => {
    expect(helloText('Hi there')).toBe('Hi there');
  });

  it.each(['', ' ', '\n\t '])('falls back to the default for the blank message %j', (blank) => {
    expect(helloText(blank)).toBe('Hello from kingofkalk!');
  });
});
