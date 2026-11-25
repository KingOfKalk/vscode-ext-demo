// `click`, `type`, `key` and `command`: act on the window like a person with a mouse and a keyboard.
// Every wait here has a deadline and a message that says what did not happen; no fixed sleeps.
import { setTimeout as sleep } from 'node:timers/promises';
import type { Frame, Locator, Page } from 'playwright-core';
import { parseAriaSnapshot, type AriaNode } from './aria.ts';
import { ActionError, guard, oneLine } from './errors.ts';
import {
  describeNoRow,
  isSettled,
  nextFocusStep,
  pickRow,
  samePalette,
  type PaletteRow,
  type PaletteState,
} from './palette.ts';
import { waitFor } from './processes.ts';
import { collectSnapshot, formatSnapshot, MODAL_EDITOR } from './snapshot.ts';
import {
  candidateTarget,
  decideCounts,
  decideMatches,
  describeNone,
  describeSeveral,
  findNamed,
  parseTarget,
  type Scope,
} from './targets.ts';
import type { Connection } from './vscode.ts';

const ACTION_TIMEOUT_MS = 5000;
/** How long `click` looks for a change in the window after the click. */
const EFFECT_TIMEOUT_MS = 1500;
const EFFECT_POLL_MS = 50;

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
  return guard('cannot read the window', async () =>
    parseAriaSnapshot(await frame.locator('body').ariaSnapshot({ timeout: ACTION_TIMEOUT_MS })),
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
  const found = await guard('cannot describe the elements', () =>
    locator.evaluateAll((elements: PageElement[]) =>
      elements.slice(0, 12).map((element) => {
        const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
        const id = element.id ? `#${element.id}` : '';
        return `${element.tagName.toLowerCase()}${id} "${text}"`;
      }),
    ),
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
    const counts = await guard('cannot count the elements', () =>
      Promise.all(found.map(({ locator }) => locator.count())),
    );
    const decision = decideCounts(counts);
    if (decision.kind === 'one') {
      const hit = found[decision.value];
      if (hit) return { locator: hit.locator, description: `css=${target.selector}` };
    }
    if (decision.kind === 'none') throw new ActionError(`no visible element matches ${text}`);
    const rows = (
      await Promise.all(found.map(({ scope, locator }) => describeElements(locator, scope)))
    ).flat();
    throw new ActionError(
      `${counts.reduce((sum, n) => sum + n, 0)} elements match ${text}; narrow the selector:\n${rows.map((row) => `  ${row}`).join('\n')}`,
    );
  }
  const scopes = await Promise.all(
    frames.map(async ({ scope, frame }) => ({ scope, frame, nodes: await readTree(frame) })),
  );
  const found = findNamed(scopes, target.name, target.role);
  const decision = decideMatches(found);
  if (decision.kind === 'several') throw new ActionError(describeSeveral(text, found));
  if (decision.kind === 'none') {
    throw new ActionError(describeNone(target.name, scopes, target.role));
  }
  const only = decision.value;
  const frame = scopes.find(({ scope }) => scope === only.scope)?.frame;
  if (!frame) throw new ActionError(`the ${only.scope} is gone; try again`);
  const locator = frame.getByRole(only.role as Parameters<Frame['getByRole']>[0], {
    name: only.name,
    exact: true,
  });
  return { locator, description: candidateTarget(only) };
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
  const focused = await guard('cannot ask what has the focus', () =>
    connection.page.evaluate<string>('document.activeElement?.tagName.toLowerCase() ?? "body"'),
  );
  if (focused === 'body' || focused === 'html') {
    throw new ActionError('nothing has the focus; click a field first');
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

const QUICK_INPUT = '.quick-input-widget';

/** The text in the input of the quick input, and its rows with the one that has the focus. */
async function readPalette(page: Page): Promise<PaletteState> {
  return guard('cannot read the command palette', async () => {
    const rows = await page
      .locator(`${QUICK_INPUT} .monaco-list-row`)
      .evaluateAll((elements: PageElement[]): PaletteRow[] =>
        elements.map((row) => ({
          label: row.querySelector('.label-name')?.textContent?.trim() ?? '',
          focused: row.classList.contains('focused'),
        })),
      );
    const value = await page
      .locator(`${QUICK_INPUT} .quick-input-box input`)
      .first()
      .inputValue({ timeout: ACTION_TIMEOUT_MS });
    return { value, rows };
  });
}

/** Reads the palette until two reads in a row are the same and it has the text that was typed. */
async function readSettled(page: Page, title: string): Promise<PaletteState> {
  let previous: PaletteState | undefined;
  return waitFor(
    `the command palette settles on "${title}"`,
    async () => {
      const now = await readPalette(page);
      const settled = isSettled(previous, now, title);
      previous = now;
      return settled ? now : undefined;
    },
    { timeoutMs: ACTION_TIMEOUT_MS, pauseMs: EFFECT_POLL_MS },
  ).catch((error: unknown) => {
    throw new ActionError(oneLine(error));
  });
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

/**
 * Moves the focus down the palette until it is on the row with this title, and presses Enter there.
 * Every decision is made on a list that has settled, and Enter only if a read right before it is
 * the same: the list filters a moment after typing, and Enter runs whatever has the focus then.
 */
async function runFocused(page: Page, title: string): Promise<void> {
  let steps = 0;
  for (;;) {
    const state = await readSettled(page, title);
    const step = nextFocusStep(state.rows, title, steps);
    if (step === 'unreachable') throw new ActionError(`the row "${title}" cannot be reached`);
    if (step === 'enter') {
      if (!samePalette(state, await readPalette(page))) continue; // It moved; look again.
      await page.keyboard.press('Enter');
      return;
    }
    await page.keyboard.press('ArrowDown');
    steps++;
    // The list moves its focus a moment later; do not decide on the list before it did.
    const was = state.rows.findIndex(({ focused }) => focused);
    await waitFor(
      'the focus moves to the next row',
      async () =>
        (await readPalette(page)).rows.findIndex(({ focused }) => focused) !== was
          ? true
          : undefined,
      { timeoutMs: ACTION_TIMEOUT_MS, pauseMs: EFFECT_POLL_MS },
    ).catch((error: unknown) => {
      throw new ActionError(oneLine(error));
    });
  }
}

/** Throws if an editor lies over the window (Settings opens like this): the palette does not open then. */
export async function assertNoOverlay(page: Page): Promise<void> {
  if (await page.locator(MODAL_EDITOR).first().isVisible()) {
    throw new ActionError('an editor lies over the window; close it first: key Escape');
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
    await assertNoOverlay(page);
    await page.keyboard.press('F1');
    await page.locator(QUICK_INPUT).waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
    await page.keyboard.insertText(title);
    // The list filters as it is typed. If it settles without the title, show what is there.
    const settled = await readSettled(page, title).catch(() => readPalette(page));
    const pick = pickRow(settled.rows, title);
    if (pick.kind === 'none') throw new ActionError(describeNoRow(title, pick.top));
    if (pick.kind === 'several') {
      throw new ActionError(`${pick.count} commands are titled "${title}"`);
    }
    await runFocused(page, title);
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
