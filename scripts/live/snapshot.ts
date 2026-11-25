// `snapshot`: the visible UI as plain text, for an agent that cannot look at a picture. Stable order,
// one line per thing, the names are those that `click` takes.
import type { Frame, Page } from 'playwright-core';
import { parseAriaSnapshot, type AriaNode } from './aria.ts';
import { guard, userError } from './errors.ts';
import { BlankWindowError, type Connection } from './vscode.ts';

/** What `collectSnapshot` reads; each part is empty if it is not visible. */
export interface UiSnapshot {
  activityBar: AriaNode[];
  sidebar: AriaNode[];
  editorTabs: AriaNode[];
  /** Undefined if the panel (Output, Terminal, …) is closed. */
  panel: AriaNode[] | undefined;
  /** Undefined if there is no Demo window or its tab is hidden. */
  window: AriaNode[] | undefined;
  /** The Demo window is shown, but blank: it never shows a count. */
  windowBlank?: boolean;
  statusBar: AriaNode[];
  notifications: AriaNode[];
  /** The title of the editor that lies over the window (Settings opens like this); undefined if none. */
  modalEditor: string | undefined;
  /** Undefined if the quick input (command palette, picker) is closed. */
  quickInput: AriaNode[] | undefined;
  /** Undefined if no modal dialog is open. */
  dialog: AriaNode[] | undefined;
}

/** Roles that only group; they have no line of their own. */
const GROUPS = new Set([
  'application',
  'document',
  'list',
  'listbox',
  'main',
  'menubar',
  'region',
  'status',
  'tablist',
  'toolbar',
  'tree',
]);

const MAX_QUICK_INPUT_ROWS = 10;

function states(node: AriaNode): string {
  const shown = node.states.filter(
    (state) => !state.startsWith('level=') && !(state === 'expanded' && node.role === 'tab'),
  );
  return shown.length > 0 ? ` [${shown.join(', ')}]` : '';
}

/** `name [selected]`, or the text if the element has no name. */
function label(node: AriaNode): string {
  return `${node.name || node.text}${states(node)}`;
}

function level(node: AriaNode): number {
  const value = node.states.find((state) => state.startsWith('level='));
  return value ? Number(value.slice('level='.length)) : 1;
}

function line(title: string, items: readonly string[]): string {
  return `${title}: ${items.length > 0 ? items.join(' | ') : 'none'}`;
}

function indented(lines: readonly string[]): string[] {
  return lines.map((text) => `  ${text}`);
}

function sidebarLines(nodes: readonly AriaNode[]): string[] {
  if (nodes.length === 0) return ['Sidebar: closed'];
  const title = nodes.find(({ role }) => role === 'heading');
  const rows = nodes
    .filter((node) => node !== title && !GROUPS.has(node.role) && node.role !== 'heading')
    .map((node) =>
      node.role === 'treeitem'
        ? `${'  '.repeat(level(node) - 1)}${label(node)}`
        : `[${node.role}] ${label(node)}`,
    );
  return [`Sidebar: ${title?.name ?? ''}`, ...indented(rows)];
}

function windowLines(nodes: readonly AriaNode[] | undefined, blank = false): string[] {
  if (blank)
    return ['Window: blank (shown, but it never showed a count; see: npm run live -- logs)'];
  if (!nodes) return ['Window: none (not open, or its tab is hidden)'];
  const rows = nodes
    .filter((node) => !GROUPS.has(node.role))
    .map((node) => (node.name === '' ? node.text : `[${node.role}] ${label(node)}`))
    .filter((text) => text !== '');
  return ['Window:', ...indented(rows)];
}

/** `Info: text`: the dialog's name starts with the severity, its text is the message. */
function notificationLines(nodes: readonly AriaNode[]): string[] {
  const rows = nodes
    .filter(({ role }) => role === 'dialog')
    .map(({ name, text }) => `${name.split(':')[0] ?? ''}: ${text}`);
  return rows.length > 0 ? ['Notifications:', ...indented(rows)] : [];
}

/** `Panel: <selected tab>`, and for the Output tab the selected channel; nothing if it is closed. */
function panelLines(nodes: readonly AriaNode[] | undefined): string[] {
  if (!nodes) return [];
  const tab = nodes.find(({ role, states }) => role === 'tab' && states.includes('selected'));
  const channel = nodes.find(
    ({ role, states }) => role === 'option' && states.includes('selected'),
  );
  return [`Panel: ${tab?.name ?? 'unknown'}${channel ? ` | channel: ${channel.name}` : ''}`];
}

/** A modal dialog: its name starts with the severity, its buttons are the direct children. */
function dialogLines(nodes: readonly AriaNode[] | undefined): string[] {
  const dialog = nodes?.find(({ role }) => role === 'dialog');
  if (!nodes || !dialog) return [];
  const buttons = nodes
    .filter(({ role, depth }) => role === 'button' && depth === dialog.depth + 1)
    .map(({ name }) => name);
  return [`Dialog: ${dialog.name} | buttons: ${buttons.join(' | ')} (key Escape cancels it)`];
}

function quickInputLines(nodes: readonly AriaNode[] | undefined): string[] {
  if (!nodes) return [];
  const input = nodes.find(({ role }) => role === 'textbox');
  const options = nodes.filter(({ role }) => role === 'option').map((node) => label(node));
  const rows = options.slice(0, MAX_QUICK_INPUT_ROWS);
  if (options.length > rows.length) rows.push(`… ${options.length - rows.length} more`);
  return [`Quick input: "${input?.text ?? ''}"`, ...indented(rows)];
}

/** The text of `snapshot`, in a fixed order. Notifications and the quick input show only when open. */
export function formatSnapshot(ui: UiSnapshot): string {
  return [
    line(
      'Activity bar',
      ui.activityBar.filter(({ role }) => role !== 'tablist' && role !== 'toolbar').map(label),
    ),
    ...sidebarLines(ui.sidebar),
    line('Editor tabs', ui.editorTabs.filter(({ role }) => role === 'tab').map(label)),
    ...windowLines(ui.window, ui.windowBlank),
    ...panelLines(ui.panel),
    line('Status bar', ui.statusBar.filter(({ role }) => !GROUPS.has(role)).map(label)),
    ...(ui.modalEditor === undefined
      ? []
      : [`Modal editor: ${ui.modalEditor} (key Escape closes it)`]),
    ...dialogLines(ui.dialog),
    ...notificationLines(ui.notifications),
    ...quickInputLines(ui.quickInput),
  ].join('\n');
}

const READ_TIMEOUT_MS = 5000;
/** For what comes and goes (a toast, the palette, the Demo window): if it is gone, it is not shown. */
const TRANSIENT_TIMEOUT_MS = 1000;
/** Where VS Code puts an editor over the window, like Settings. */
export const MODAL_EDITOR = '.modal-editor-part';

/**
 * Runs the read of a part. A part that comes and goes can vanish while it is read; then it is not
 * shown, which is true, instead of an error after a wait. The others must be there.
 */
async function readOf<T>(
  what: string,
  transient: boolean,
  read: (timeout: number) => Promise<T | undefined>,
): Promise<T | undefined> {
  if (!transient) return guard(`cannot read ${what}`, () => read(READ_TIMEOUT_MS));
  try {
    return await read(TRANSIENT_TIMEOUT_MS);
  } catch {
    return undefined;
  }
}

/** The tree of a part of the window, undefined if it is not visible. */
function readPart(
  from: Page | Frame,
  selector: string,
  what: string,
  transient: boolean,
): Promise<AriaNode[] | undefined> {
  return readOf(what, transient, async (timeout) => {
    const part = from.locator(selector).first();
    if (!(await part.isVisible())) return undefined;
    return parseAriaSnapshot(await part.ariaSnapshot({ timeout }));
  });
}

/** The title of the modal editor, if one is open. */
function readModalEditor(page: Page): Promise<string | undefined> {
  return readOf('the editor over the window', true, async (timeout) => {
    if (!(await page.locator(MODAL_EDITOR).first().isVisible())) return undefined;
    const title = await page.locator('#modal-editor-title').first().innerText({ timeout });
    return title.trim() || 'untitled';
  });
}

/** Reads the window now. The Demo window is looked up again each time, see `Connection.webview`. */
export async function collectSnapshot(connection: Connection): Promise<UiSnapshot> {
  const { page } = connection;
  const part = async (id: string) =>
    (await readPart(page, `[id="workbench.parts.${id}"]`, `the ${id}`, false)) ?? [];
  let blank = false;
  const frame = await connection.webview().catch((error: unknown) => {
    if (!(error instanceof BlankWindowError)) throw userError(error, 'cannot find the Demo window');
    blank = true;
    return undefined;
  });
  const [
    activityBar,
    sidebar,
    editorTabs,
    statusBar,
    toasts,
    center,
    quickInput,
    modalEditor,
    panel,
    dialog,
    win,
  ] = await Promise.all([
    part('activitybar'),
    part('sidebar'),
    part('editor'),
    part('statusbar'),
    readPart(page, '.notifications-toasts', 'the notifications', true),
    readPart(page, '.notifications-center', 'the notification centre', true),
    readPart(page, '.quick-input-widget', 'the quick input', true),
    readModalEditor(page),
    readPart(page, '[id="workbench.parts.panel"]', 'the panel', true),
    readPart(page, '.monaco-dialog-box', 'the dialog', true),
    frame ? readPart(frame, 'body', 'the Demo window', true) : undefined,
  ]);
  return {
    activityBar,
    sidebar,
    editorTabs,
    panel,
    window: win,
    windowBlank: blank,
    statusBar,
    notifications: [...(toasts ?? []), ...(center ?? [])],
    modalEditor,
    quickInput,
    dialog,
  };
}

/** Prints the visible UI as text. */
export async function snapshot(connection: Connection): Promise<string> {
  return formatSnapshot(await collectSnapshot(connection));
}
