// `snapshot`: the visible UI as plain text, for an agent that cannot look at a picture. Stable order,
// one line per thing, the names are those that `click` takes.
import type { Frame, Page } from 'playwright-core';
import { parseAriaSnapshot, type AriaNode } from './aria.ts';
import type { Connection } from './vscode.ts';

/** What `collectSnapshot` reads; each part is empty if it is not visible. */
export interface UiSnapshot {
  activityBar: AriaNode[];
  sidebar: AriaNode[];
  editorTabs: AriaNode[];
  /** Undefined if there is no Demo window or its tab is hidden. */
  window: AriaNode[] | undefined;
  statusBar: AriaNode[];
  notifications: AriaNode[];
  /** The title of the editor that lies over the window (Settings opens like this); undefined if none. */
  modalEditor: string | undefined;
  /** Undefined if the quick input (command palette, picker) is closed. */
  quickInput: AriaNode[] | undefined;
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

function windowLines(nodes: readonly AriaNode[] | undefined): string[] {
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
    ...windowLines(ui.window),
    line('Status bar', ui.statusBar.filter(({ role }) => !GROUPS.has(role)).map(label)),
    ...(ui.modalEditor === undefined
      ? []
      : [`Modal editor: ${ui.modalEditor} (key Escape closes it)`]),
    ...notificationLines(ui.notifications),
    ...quickInputLines(ui.quickInput),
  ].join('\n');
}

const READ_TIMEOUT_MS = 5000;
/** Where VS Code puts an editor over the window, like Settings. */
export const MODAL_EDITOR = '.modal-editor-part';

/** The tree of a part of the window, empty if it is not there or not visible. */
async function readPart(from: Page | Frame, selector: string): Promise<AriaNode[] | undefined> {
  const part = from.locator(selector).first();
  try {
    if (!(await part.isVisible())) return undefined;
    return parseAriaSnapshot(await part.ariaSnapshot({ timeout: READ_TIMEOUT_MS }));
  } catch (error) {
    // The Demo window is replaced when its tab is shown or hidden; what is gone is not shown.
    if ('mainFrame' in from) throw error; // A page: nothing may go wrong there.
    return undefined;
  }
}

/** The title of the modal editor, if one is open. */
async function readModalEditor(page: Page): Promise<string | undefined> {
  if (!(await page.locator(MODAL_EDITOR).first().isVisible())) return undefined;
  const title = await page
    .locator('#modal-editor-title')
    .first()
    .innerText({ timeout: READ_TIMEOUT_MS });
  return title.trim() || 'untitled';
}

/** Reads the window now. The Demo window is looked up again each time, see `Connection.webview`. */
export async function collectSnapshot(connection: Connection): Promise<UiSnapshot> {
  const { page } = connection;
  const part = async (id: string) => (await readPart(page, `[id="workbench.parts.${id}"]`)) ?? [];
  const frame = await connection.webview();
  const [
    activityBar,
    sidebar,
    editorTabs,
    statusBar,
    toasts,
    center,
    quickInput,
    modalEditor,
    win,
  ] = await Promise.all([
    part('activitybar'),
    part('sidebar'),
    part('editor'),
    part('statusbar'),
    readPart(page, '.notifications-toasts'),
    readPart(page, '.notifications-center'),
    readPart(page, '.quick-input-widget'),
    readModalEditor(page),
    frame ? readPart(frame, 'body') : undefined,
  ]);
  return {
    activityBar,
    sidebar,
    editorTabs,
    window: win,
    statusBar,
    notifications: [...(toasts ?? []), ...(center ?? [])],
    modalEditor,
    quickInput,
  };
}

/** Prints the visible UI as text. */
export async function snapshot(connection: Connection): Promise<string> {
  return formatSnapshot(await collectSnapshot(connection));
}
