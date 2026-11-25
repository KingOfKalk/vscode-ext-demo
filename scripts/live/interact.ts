// `click`, `type`, `key` and `command`: act on the window like a person with a mouse and a keyboard.
// Every wait here has a deadline and a message that says what did not happen; no fixed sleeps.
import { setTimeout as sleep } from 'node:timers/promises';
import type { Frame, Locator, Page } from 'playwright-core';
import { parseAriaSnapshot, type AriaNode } from './aria.ts';
import { waitFor } from './processes.ts';
import { collectSnapshot, formatSnapshot, MODAL_EDITOR } from './snapshot.ts';
import {
  describeNone,
  describeSeveral,
  findNamed,
  formatCandidate,
  parseTarget,
  type Scope,
} from './targets.ts';
import type { Connection } from './vscode.ts';

const ACTION_TIMEOUT_MS = 5000;
/** How long `click` looks for a change in the window after the click. */
const EFFECT_TIMEOUT_MS = 1500;
const EFFECT_POLL_MS = 50;
const MAX_LISTED_ROWS = 5;

/** The first line of an error, and the last line of Playwright's log (what it was waiting for). */
export function oneLine(error: unknown): string {
  const lines = (error instanceof Error ? error.message : String(error)).split('\n');
  const first = lines[0]?.trim() ?? '';
  const last = lines
    .slice(1)
    .map((text) => text.trim())
    .filter((text) => text.startsWith('-'))
    .at(-1);
  return last && last !== first ? `${first} (${last.replace(/^-\s*/, '')})` : first;
}

interface ScopedFrame {
  scope: Scope;
  frame: Frame;
}

function scopedFrames(page: Page, webview: Frame | undefined): ScopedFrame[] {
  return [
    { scope: 'workbench', frame: page.mainFrame() },
    ...(webview ? [{ scope: 'webview' as const, frame: webview }] : []),
  ];
}

async function readTree(frame: Frame): Promise<AriaNode[]> {
  return parseAriaSnapshot(
    await frame.locator('body').ariaSnapshot({ timeout: ACTION_TIMEOUT_MS }),
  );
}

/**
 * The little of an element that the functions below use. The scripts are typed without the DOM
 * library: they run in Node, and these functions run in the window.
 */
interface PageElement {
  id: string;
  tagName: string;
  textContent: string | null;
  classList: { contains(name: string): boolean };
  querySelector(selector: string): PageElement | null;
}

/** What is at the end of a css target, for the error that lists several. */
async function describeElements(locator: Locator, scope: Scope): Promise<string[]> {
  const found = await locator.evaluateAll((elements: PageElement[]) =>
    elements.slice(0, 12).map((element) => {
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const id = element.id ? `#${element.id}` : '';
      return `${element.tagName.toLowerCase()}${id} "${text}"`;
    }),
  );
  return found.map((text) => `${text} (${scope})`);
}

export interface Resolved {
  locator: Locator;
  /** What was found, as a target that finds exactly it. */
  description: string;
}

/**
 * Finds the one element a target means, in the window of VS Code and in the Demo window.
 *
 * - `css=<selector>`: a selector, visible elements only
 * - `role=<role>:<name>`: an accessible name with its role
 * - anything else: an accessible name, matched exactly, case and all
 *
 * More than one match in both places together is an error, not a pick: names collide ("Demo" is a
 * tab, a status bar item and a view), and a click on the wrong one is worse than no click.
 * @throws if nothing or more than one element matches; the message lists them
 */
export async function resolve(
  page: Page,
  webview: Frame | undefined,
  text: string,
): Promise<Resolved> {
  const target = parseTarget(text);
  const frames = scopedFrames(page, webview);
  if (target.kind === 'css') {
    const found = frames.map(({ scope, frame }) => ({
      scope,
      locator: frame.locator(target.selector).filter({ visible: true }),
    }));
    const counts = await Promise.all(found.map(({ locator }) => locator.count()));
    const total = counts.reduce((sum, count) => sum + count, 0);
    if (total === 1) {
      const index = counts.findIndex((count) => count === 1);
      const hit = found[index];
      if (hit) return { locator: hit.locator, description: `css=${target.selector}` };
    }
    if (total === 0) throw new Error(`no visible element matches ${text}`);
    const rows = (
      await Promise.all(found.map(({ scope, locator }) => describeElements(locator, scope)))
    ).flat();
    throw new Error(
      `${total} elements match ${text}; narrow the selector:\n${rows.map((row) => `  ${row}`).join('\n')}`,
    );
  }
  const scopes = await Promise.all(
    frames.map(async ({ scope, frame }) => ({ scope, frame, nodes: await readTree(frame) })),
  );
  const found = findNamed(scopes, target.name, target.role);
  const [only] = found;
  if (found.length > 1) throw new Error(describeSeveral(text, found));
  if (!only) throw new Error(describeNone(target.name, scopes, target.role));
  const frame = scopes.find(({ scope }) => scope === only.scope)?.frame;
  if (!frame) throw new Error(`the ${only.scope} is gone; try again`);
  const locator = frame.getByRole(only.role as Parameters<Frame['getByRole']>[0], {
    name: only.name,
    exact: true,
  });
  return { locator, description: formatCandidate(only) };
}

/** `resolve`, for those that only need the element. */
export async function resolveTarget(
  page: Page,
  webview: Frame | undefined,
  target: string,
): Promise<Locator> {
  return (await resolve(page, webview, target)).locator;
}

async function resolveNow(connection: Connection, target: string): Promise<Resolved> {
  // The Demo window is a new frame each time its tab is shown, so ask for it each time.
  return resolve(connection.page, await connection.webview(), target);
}

async function fingerprint(connection: Connection): Promise<string> {
  return formatSnapshot(await collectSnapshot(connection));
}

/**
 * Clicks the target and waits until the window looks different, but at most `EFFECT_TIMEOUT_MS`:
 * a click can also change nothing. Returns what was clicked and whether something changed.
 */
export async function click(connection: Connection, target: string): Promise<string> {
  const { locator, description } = await resolveNow(connection, target);
  const before = await fingerprint(connection);
  try {
    await locator.click({ timeout: ACTION_TIMEOUT_MS });
  } catch (error) {
    throw new ActionError(`cannot click ${description}: ${oneLine(error)}`);
  }
  const end = Date.now() + EFFECT_TIMEOUT_MS;
  for (;;) {
    if ((await fingerprint(connection)) !== before) return `clicked ${description}`;
    if (Date.now() >= end) return `clicked ${description} (the window did not change)`;
    await sleep(EFFECT_POLL_MS);
  }
}

/** Types into what has the focus; click a field first. */
export async function type(connection: Connection, text: string): Promise<string> {
  const focused = await connection.page.evaluate<string>(
    'document.activeElement?.tagName.toLowerCase() ?? "body"',
  );
  if (focused === 'body' || focused === 'html') {
    throw new Error('nothing has the focus; click a field first');
  }
  try {
    await connection.page.keyboard.type(text);
  } catch (error) {
    throw new ActionError(`cannot type: ${oneLine(error)}`);
  }
  return `typed ${[...text].length} characters`;
}

/** Presses a key or a combination in Playwright's notation: `Enter`, `Control+Shift+P`. */
export async function key(connection: Connection, combo: string): Promise<string> {
  try {
    await connection.page.keyboard.press(combo);
  } catch (error) {
    throw new ActionError(`cannot press "${combo}": ${oneLine(error)}`);
  }
  return `pressed ${combo}`;
}

/**
 * A failure that is worded for the user and whole as it is. Playwright's errors are not: they carry
 * a log, so `oneLine` cuts them, and they are put into one of these.
 */
class ActionError extends Error {
  override name = 'ActionError';
}

const QUICK_INPUT = '.quick-input-widget';

/** The labels of the rows of the quick input, and which one has the focus. */
async function paletteRows(page: Page): Promise<{ label: string; focused: boolean }[]> {
  return page.locator(`${QUICK_INPUT} .monaco-list-row`).evaluateAll((rows: PageElement[]) =>
    rows.map((row) => ({
      label: row.querySelector('.label-name')?.textContent?.trim() ?? '',
      focused: row.classList.contains('focused'),
    })),
  );
}

async function paletteOpen(page: Page): Promise<boolean> {
  return page.locator(QUICK_INPUT).isVisible();
}

async function closePalette(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3 && (await paletteOpen(page)); attempt++) {
    await page.keyboard.press('Escape');
    await page
      .locator(QUICK_INPUT)
      .waitFor({ state: 'hidden', timeout: 1000 })
      .catch(() => undefined);
  }
}

/** Moves the focus down the palette until it is on the row with this label. */
async function focusRow(page: Page, label: string): Promise<void> {
  for (let step = 0; ; step++) {
    const rows = await paletteRows(page);
    const at = rows.findIndex(({ focused }) => focused);
    if (rows[at]?.label === label) return;
    if (step >= rows.length) throw new ActionError(`the row "${label}" cannot be reached`);
    await page.keyboard.press('ArrowDown');
    // The list moves its focus a moment later; Enter must not run the row it left.
    await waitFor(
      'the focus moves to the next row',
      async () =>
        (await paletteRows(page)).findIndex(({ focused }) => focused) !== at ? true : undefined,
      { timeoutMs: ACTION_TIMEOUT_MS, pauseMs: EFFECT_POLL_MS },
    );
  }
}

/**
 * Runs a command of the command palette by its exact title, like `Demo: Open Window`.
 * Opens the palette with F1, types the title, and runs the row only if its label is the title.
 * Closes the palette again on every failure.
 * @throws if the palette shows no row with exactly this title
 */
export async function runCommand(connection: Connection, title: string): Promise<string> {
  const { page } = connection;
  await closePalette(page);
  try {
    // The palette does not open over it.
    if (await page.locator(MODAL_EDITOR).first().isVisible()) {
      throw new ActionError('an editor lies over the window; close it first: key Escape');
    }
    await page.keyboard.press('F1');
    await page.locator(QUICK_INPUT).waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
    await page.keyboard.insertText(title);
    // The list filters as it is typed: wait for the row; if it does not come, show what is there.
    const isTitle = ({ label }: { label: string }) => label === title;
    const rows = await waitFor(
      `the command palette shows "${title}"`,
      async () => {
        const now = await paletteRows(page);
        return now.some(isTitle) ? now : undefined;
      },
      { timeoutMs: ACTION_TIMEOUT_MS, pauseMs: EFFECT_POLL_MS },
    ).catch(() => paletteRows(page));
    const exact = rows.filter(isTitle);
    if (exact.length === 0) {
      const top = rows.slice(0, MAX_LISTED_ROWS).map(({ label }) => `  ${label}`);
      throw new ActionError(
        `no command is titled exactly "${title}"` +
          (top.length > 0
            ? `; the palette shows:\n${top.join('\n')}`
            : '; the palette shows nothing'),
      );
    }
    if (exact.length > 1) throw new ActionError(`${exact.length} commands are titled "${title}"`);
    await focusRow(page, title);
    await page.keyboard.press('Enter');
    // The palette closes when the command runs. A command that asks for input keeps it open.
    await page
      .locator(QUICK_INPUT)
      .waitFor({ state: 'hidden', timeout: ACTION_TIMEOUT_MS })
      .catch(() => {
        throw new ActionError('the palette is still open, the command may ask for input');
      });
  } catch (error) {
    await closePalette(page).catch(() => undefined);
    const why = error instanceof ActionError ? error.message : oneLine(error);
    throw new ActionError(`command "${title}" failed: ${why}`);
  }
  return `ran ${title}`;
}
