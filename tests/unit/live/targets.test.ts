import { describe, expect, it } from 'vitest';
import type { AriaNode } from '../../../scripts/live/aria.ts';
import {
  describeNone,
  describeSeveral,
  findNamed,
  candidateTarget,
  decideCounts,
  decideMatches,
  listCandidates,
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
    expect(findNamed(SCOPES, 'Reset Count')).toEqual([]);
  });

  it('finds the same name with several roles', () => {
    expect(findNamed(SCOPES, 'Demo').map(candidateTarget)).toEqual([
      'role=tab:Demo',
      'role=heading:Demo',
    ]);
  });

  it('narrows by role', () => {
    expect(findNamed(SCOPES, 'Demo', 'tab').map(candidateTarget)).toEqual(['role=tab:Demo']);
    expect(findNamed(SCOPES, 'Demo', 'button')).toEqual([]);
  });
});

describe('decideMatches and decideCounts', () => {
  it('has nothing, one, or several', () => {
    expect(decideMatches([])).toEqual({ kind: 'none' });
    expect(decideMatches(['a'])).toEqual({ kind: 'one', value: 'a' });
    expect(decideMatches(['a', 'b'])).toEqual({ kind: 'several' });
    expect(decideMatches(['a', 'a'])).toEqual({ kind: 'several' });
  });

  it('counts the matches of all places together, not place by place', () => {
    expect(decideCounts([0, 0])).toEqual({ kind: 'none' });
    expect(decideCounts([])).toEqual({ kind: 'none' });
    expect(decideCounts([1, 0])).toEqual({ kind: 'one', value: 0 });
    expect(decideCounts([0, 1])).toEqual({ kind: 'one', value: 1 });
    expect(decideCounts([1, 1])).toEqual({ kind: 'several' });
    expect(decideCounts([2, 0])).toEqual({ kind: 'several' });
  });
});

/** The lines that are targets: not the place headings, not the notes. */
function targetLines(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('    '))
    .map((line) => line.trim());
}

describe('listCandidates', () => {
  it('writes each target on a line of its own, under its place', () => {
    const text = listCandidates(findNamed(SCOPES, 'Demo').concat(findNamed(SCOPES, 'Reset')));
    expect(text).toBe(
      [
        '  in the Demo window:',
        '    role=button:Reset',
        '  in the window of VS Code:',
        '    role=tab:Demo',
        '    role=heading:Demo',
      ].join('\n'),
    );
  });

  it('writes a target once, however often it occurs, and says it does not narrow', () => {
    const twice = { scope: 'workbench', role: 'treeitem', name: 'Open window' } as const;
    const text = listCandidates([twice, twice, { scope: 'workbench', role: 'tab', name: 'Demo' }]);
    expect(targetLines(text)).toEqual(['role=treeitem:Open window', 'role=tab:Demo']);
    expect(text).toContain('not unique');
    expect(text).toContain('role=treeitem:Open window');
    expect(text).toContain('css=<selector>');
  });

  it('also says it when the same role and name are in both places', () => {
    const text = listCandidates([
      { scope: 'workbench', role: 'button', name: 'Reset' },
      { scope: 'webview', role: 'button', name: 'Reset' },
    ]);
    expect(targetLines(text)).toEqual(['role=button:Reset', 'role=button:Reset']);
    expect(text).toContain('not unique');
  });

  it('says nothing about uniqueness when each target is unique', () => {
    expect(listCandidates(findNamed(SCOPES, 'Demo'))).not.toContain('not unique');
  });

  it('cuts a long list', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      scope: 'workbench' as const,
      role: 'button',
      name: `B${i}`,
    }));
    const text = listCandidates(many, '; more');
    expect(targetLines(text)).toHaveLength(12);
    expect(text).toContain('… 8 more; more');
  });
});

describe('error texts', () => {
  it('lists the several matches', () => {
    expect(describeSeveral('Demo', findNamed(SCOPES, 'Demo'))).toBe(
      '2 elements match "Demo"; narrow it with one of:\n' +
        '  in the window of VS Code:\n    role=tab:Demo\n    role=heading:Demo',
    );
  });

  it('every line that is listed, pasted back as a target, is a target for that very element', () => {
    const several = describeSeveral('Demo', findNamed(SCOPES, 'Demo'));
    const none = describeNone('Nope', SCOPES);
    const similar = describeNone('reset', SCOPES);
    for (const text of [several, none, similar]) {
      const lines = targetLines(text);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        const target = parseTarget(line);
        expect(target.kind).toBe('name');
        if (target.kind !== 'name') continue;
        const found = findNamed(SCOPES, target.name, target.role);
        expect(found.length).toBeGreaterThan(0);
        expect(found.map(candidateTarget)).toContain(line);
      }
    }
  });

  it('lists similar names when nothing matches', () => {
    const text = describeNone('reset', SCOPES);
    expect(text).toContain('nothing is named "reset" exactly; similar:');
    expect(text).toContain('role=button:Reset');
    expect(text).toContain('role=button:Reset Counter');
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
