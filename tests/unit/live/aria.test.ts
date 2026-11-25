import { describe, expect, it } from 'vitest';
import { parseAriaSnapshot } from '../../../scripts/live/aria.ts';

describe('parseAriaSnapshot', () => {
  it('reads role, name, states, text and depth', () => {
    const nodes = parseAriaSnapshot(
      [
        '- tablist "Active View Switcher":',
        '  - tab "Explorer (Ctrl+Shift+E)" [expanded] [selected]: ',
        '  - tab "Demo"',
        '- heading "Demo" [level=2]',
      ].join('\n'),
    );
    expect(nodes).toEqual([
      { role: 'tablist', name: 'Active View Switcher', states: [], text: '', depth: 0 },
      {
        role: 'tab',
        name: 'Explorer (Ctrl+Shift+E)',
        states: ['expanded', 'selected'],
        text: '',
        depth: 1,
      },
      { role: 'tab', name: 'Demo', states: [], text: '', depth: 1 },
      { role: 'heading', name: 'Demo', states: ['level=2'], text: '', depth: 0 },
    ]);
  });

  it('reads keys that YAML quotes, and the quotes of a text', () => {
    const [button, item, paragraph] = parseAriaSnapshot(
      [
        `- 'button "dashboard Demo: 1, Open the Demo window"': " Demo: 1"`,
        `- 'treeitem "It''s: here" [level=1]': " Counter: 1"`,
        '- paragraph: "Clicked: 1"',
      ].join('\n'),
    );
    expect(button).toMatchObject({
      role: 'button',
      name: 'dashboard Demo: 1, Open the Demo window',
      text: 'Demo: 1',
    });
    expect(item).toMatchObject({
      role: 'treeitem',
      name: "It's: here",
      states: ['level=1'],
      text: 'Counter: 1',
    });
    expect(paragraph).toMatchObject({ role: 'paragraph', name: '', text: 'Clicked: 1' });
  });

  it('unescapes quotes and backslashes in a name', () => {
    const [node] = parseAriaSnapshot(String.raw`- button "Split Editor Right (Ctrl+\\) \"x\""`);
    expect(node?.name).toBe(String.raw`Split Editor Right (Ctrl+\) "x"`);
  });

  it('drops text and property lines, and the inside of an iframe', () => {
    const nodes = parseAriaSnapshot(
      [
        '- main:',
        '  - text: hello',
        '  - link "Docs":',
        '    - /url: https://example.org',
        '  - iframe',
        '    - button "Inside"',
        '  - button "After"',
      ].join('\n'),
    );
    expect(nodes.map(({ role, name }) => `${role} ${name}`.trim())).toEqual([
      'main',
      'link Docs',
      'iframe',
      'button After',
    ]);
  });

  it('removes the glyphs of icons from the text', () => {
    const [node] = parseAriaSnapshot('- treeitem "Open window" [level=1]:  Open window');
    expect(node?.text).toBe('Open window');
  });

  it('returns nothing for an empty snapshot', () => {
    expect(parseAriaSnapshot('')).toEqual([]);
  });
});
