import { describe, expect, it } from 'vitest';
import { parseAriaSnapshot } from '../../../scripts/live/aria.ts';
import { formatSnapshot, type UiSnapshot } from '../../../scripts/live/snapshot.ts';

const ACTIVITY = `- tablist "Active View Switcher":
  - tab "Explorer (Ctrl+Shift+E)": 
  - tab "Search (Ctrl+Shift+F)": 
  - tab "Demo" [expanded] [selected]
- toolbar "Manage":
  - button "Accounts": 
  - button "Manage": `;
const SIDEBAR = `- heading "Demo" [level=2]
- toolbar "Demo actions":
  - button "Open Settings": 
- toolbar
- tree "Demo":
  - treeitem "Open window" [level=1]:  Open window
  - treeitem "Say hello" [level=1]:  Say hello
  - 'treeitem "Counter: 3" [level=1]': " Counter: 3"`;
const EDITOR = `- main:
  - tablist:
    - tab "Demo Window" [selected]:
      - text:  Demo Window
      - toolbar "Tab actions":
        - button "Close (Ctrl+W)": 
  - toolbar "Editor actions":
    - button "More Actions...": `;
const WINDOW = `- document:
  - main:
    - paragraph: Hello from kingofkalk!
    - paragraph: "Clicked: 3"
    - button "Click me"
    - button "Reset"`;
const STATUS = `- status:
  - button "remote": 
  - button "No Problems":  0  0
  - 'button "dashboard Demo: 3, Open the Demo window"': " Demo: 3"
  - button "Notifications": `;
const TOAST = `- 'list "Info: Hello, source: Demo, notification"':
  - 'dialog "Info: Hello from kingofkalk!, source: Demo, notification, Inspect"':  Hello from kingofkalk!`;
const QUICK = `- textbox "Type the name of a command to run.": ">Demo: Open Win"
- text: 2 Results
- listbox "Type the name of a command to run.":
  - 'option "Demo: Open Window"':
    - text: "Demo: Open Window"
  - 'option "Demo: Focus on Demo View, similar commands"':
    - text: "Demo: Focus on Demo View similar commands"`;

type Part = Exclude<keyof UiSnapshot, 'modalEditor'>;

function ui(over: Partial<Record<Part, string | undefined>> = {}, modal?: string): UiSnapshot {
  const read = (key: Part, text: string | undefined) =>
    key in over
      ? over[key] === undefined
        ? undefined
        : parseAriaSnapshot(over[key])
      : text === undefined
        ? undefined
        : parseAriaSnapshot(text);
  return {
    activityBar: read('activityBar', ACTIVITY) ?? [],
    sidebar: read('sidebar', SIDEBAR) ?? [],
    editorTabs: read('editorTabs', EDITOR) ?? [],
    window: read('window', WINDOW),
    statusBar: read('statusBar', STATUS) ?? [],
    notifications: read('notifications', '') ?? [],
    modalEditor: modal,
    quickInput: read('quickInput', undefined),
  };
}

describe('formatSnapshot', () => {
  it('shows each part in a fixed order', () => {
    expect(formatSnapshot(ui())).toBe(
      [
        'Activity bar: Explorer (Ctrl+Shift+E) | Search (Ctrl+Shift+F) | Demo [selected] | Accounts | Manage',
        'Sidebar: Demo',
        '  [button] Open Settings',
        '  Open window',
        '  Say hello',
        '  Counter: 3',
        'Editor tabs: Demo Window [selected]',
        'Window:',
        '  Hello from kingofkalk!',
        '  Clicked: 3',
        '  [button] Click me',
        '  [button] Reset',
        'Status bar: remote | No Problems | dashboard Demo: 3, Open the Demo window | Notifications',
      ].join('\n'),
    );
  });

  it('says so when there is no window, no tab or no sidebar', () => {
    const text = formatSnapshot(ui({ window: undefined, editorTabs: '', sidebar: '' }));
    expect(text).toContain('Sidebar: closed');
    expect(text).toContain('Editor tabs: none');
    expect(text).toContain('Window: none (not open, or its tab is hidden)');
  });

  it('shows notifications with their severity, only if there are some', () => {
    expect(formatSnapshot(ui())).not.toContain('Notifications:');
    expect(formatSnapshot(ui({ notifications: TOAST }))).toContain(
      'Notifications:\n  Info: Hello from kingofkalk!',
    );
  });

  it('shows an editor that lies over the window', () => {
    expect(formatSnapshot(ui())).not.toContain('Modal editor');
    expect(formatSnapshot(ui({}, 'Settings'))).toContain(
      'Modal editor: Settings (key Escape closes it)',
    );
  });

  it('shows the quick input with its text and its first rows, only if it is open', () => {
    expect(formatSnapshot(ui())).not.toContain('Quick input');
    expect(formatSnapshot(ui({ quickInput: QUICK }))).toMatch(
      /Quick input: ">Demo: Open Win"\n {2}Demo: Open Window\n {2}Demo: Focus on Demo View, similar commands$/,
    );
  });

  it('cuts a long list of rows of the quick input', () => {
    const rows = Array.from({ length: 14 }, (_, i) => `  - option "Command ${i}"`).join('\n');
    const text = formatSnapshot(ui({ quickInput: `- textbox "x": ">"\n${rows}` }));
    expect(text).toContain('  Command 9\n  … 4 more');
    expect(text).not.toContain('Command 10');
  });

  it('indents nested rows of a tree by their level', () => {
    const text = formatSnapshot(
      ui({
        sidebar: `- heading "Explorer" [level=2]\n- tree "Files":\n  - treeitem "src" [expanded] [level=1]\n  - treeitem "a.ts" [level=2]`,
      }),
    );
    expect(text).toContain('  src [expanded]\n    a.ts');
  });
});
