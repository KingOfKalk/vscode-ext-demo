import { describe, expect, it } from 'vitest';
import type { AriaNode } from '../../../scripts/live/aria.ts';
import {
  describeNone,
  describeSeveral,
  findNamed,
  formatCandidate,
  parseTarget,
  type Scope,
} from '../../../scripts/live/targets.ts';

function node(role: string, name: string): AriaNode {
  return { role, name, states: [], text: '', depth: 0 };
}

const WORKBENCH = [
  node('tab', 'Demo'),
  node('heading', 'Demo'),
  node('treeitem', 'Open window'),
  node('button', 'Reset Counter'),
  node('button', 'dashboard Demo: 3, Open the Demo window'),
  node('toolbar', 'Title actions'),
];
const WEBVIEW = [node('button', 'Click me'), node('button', 'Reset'), node('paragraph', '')];
const SCOPES: { scope: Scope; nodes: AriaNode[] }[] = [
  { scope: 'workbench', nodes: WORKBENCH },
  { scope: 'webview', nodes: WEBVIEW },
];

describe('parseTarget', () => {
  it('takes plain text as an accessible name', () => {
    expect(parseTarget('Click me')).toEqual({ kind: 'name', name: 'Click me', role: undefined });
    expect(parseTarget('  Reset ')).toEqual({ kind: 'name', name: 'Reset', role: undefined });
  });

  it('takes css= as a selector, with everything after it', () => {
    expect(parseTarget('css=#count')).toEqual({ kind: 'css', selector: '#count' });
    expect(parseTarget('css=button[aria-label="a=b"]')).toEqual({
      kind: 'css',
      selector: 'button[aria-label="a=b"]',
    });
  });

  it('takes role=<role>:<name>, the name may have colons', () => {
    expect(parseTarget('role=tab:Demo')).toEqual({ kind: 'name', role: 'tab', name: 'Demo' });
    expect(parseTarget('role=button:dashboard Demo: 3, Open')).toEqual({
      kind: 'name',
      role: 'button',
      name: 'dashboard Demo: 3, Open',
    });
  });

  it.each(['', '   ', 'css=', 'css=  ', 'role=', 'role=tab', 'role=tab:', 'role=:x', 'role=Tab:x'])(
    'rejects %j',
    (text) => {
      expect(() => parseTarget(text)).toThrow();
    },
  );

  it('does not read a name that only starts like a prefix as one', () => {
    expect(parseTarget('Css=x')).toMatchObject({ kind: 'name', name: 'Css=x' });
  });
});

describe('findNamed', () => {
  it('matches the whole name, with its case', () => {
    expect(findNamed(SCOPES, 'Reset')).toEqual([
      { scope: 'webview', role: 'button', name: 'Reset' },
    ]);
    expect(findNamed(SCOPES, 'reset')).toEqual([]);
    expect(findNamed(SCOPES, 'Demo: 3')).toEqual([]);
  });

  it('finds the same name in both places and with several roles', () => {
    expect(findNamed(SCOPES, 'Demo').map(formatCandidate)).toEqual([
      'role=tab:Demo (workbench)',
      'role=heading:Demo (workbench)',
    ]);
  });

  it('narrows by role', () => {
    expect(findNamed(SCOPES, 'Demo', 'tab').map(formatCandidate)).toEqual([
      'role=tab:Demo (workbench)',
    ]);
    expect(findNamed(SCOPES, 'Demo', 'button')).toEqual([]);
  });
});

describe('error texts', () => {
  it('lists the several matches so that each can be written as a target', () => {
    const text = describeSeveral('Demo', findNamed(SCOPES, 'Demo'));
    expect(text).toBe(
      '2 elements match "Demo"; narrow it with one of:\n' +
        '  role=tab:Demo (workbench)\n  role=heading:Demo (workbench)',
    );
    for (const line of text.split('\n').slice(1)) {
      const target = /role=\S+:Demo/.exec(line)?.[0];
      expect(parseTarget(target ?? '')).toMatchObject({ kind: 'name', name: 'Demo' });
    }
  });

  it('lists similar names when nothing matches', () => {
    const text = describeNone('reset', SCOPES);
    expect(text).toContain('nothing is named "reset" exactly; similar:');
    expect(text).toContain('role=button:Reset (webview)');
    expect(text).toContain('role=button:Reset Counter (workbench)');
    expect(text).not.toContain('Click me');
  });

  it('lists what can be clicked, the Demo window first, when nothing is similar', () => {
    const text = describeNone('Nope', SCOPES);
    expect(text).toContain('nothing is named "Nope"; some of what there is:');
    expect(text.indexOf('Click me')).toBeLessThan(text.indexOf('Open window'));
    expect(text).not.toContain('toolbar');
    expect(text).not.toContain('paragraph');
  });

  it('says so when the role was given', () => {
    expect(describeNone('Nope', SCOPES, 'tab')).toContain(
      'nothing with the role tab is named "Nope"',
    );
  });

  it('cuts a long list and points to snapshot', () => {
    const many = Array.from({ length: 40 }, (_, i) => node('button', `Button ${i}`));
    const text = describeNone('Nope', [{ scope: 'workbench', nodes: many }]);
    expect(text.split('\n').length).toBeLessThan(20);
    expect(text).toContain('… 28 more; see: npm run live -- snapshot');
  });

  it('says so when there is nothing to list', () => {
    expect(describeNone('Nope', [])).toBe(
      'nothing is named "Nope"; nothing in the window can be clicked',
    );
  });
});
