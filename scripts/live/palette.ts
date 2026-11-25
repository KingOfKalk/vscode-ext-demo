// The decisions of `command`, on plain data: which row of the command palette is the one that was
// asked for, and what to do next. Pure. The part that reads the palette is `runCommand` in interact.ts.

export interface PaletteRow {
  label: string;
  /** The row that Enter would run. */
  focused: boolean;
}

/** What the palette shows at one moment: the text in its input and its rows. */
export interface PaletteState {
  value: string;
  rows: readonly PaletteRow[];
}

export type RowPick =
  | { kind: 'none'; top: string[] }
  | { kind: 'several'; count: number }
  | { kind: 'one'; index: number };

const MAX_TOP = 5;

/** Which row has exactly this title, as a whole and with its case: not one that only contains it. */
export function pickRow(rows: readonly PaletteRow[], title: string): RowPick {
  const hits = rows.flatMap(({ label }, index) => (label === title ? [index] : []));
  const [index] = hits;
  if (index === undefined)
    return { kind: 'none', top: rows.slice(0, MAX_TOP).map((row) => row.label) };
  if (hits.length > 1) return { kind: 'several', count: hits.length };
  return { kind: 'one', index };
}

/** The message for `pickRow` finding nothing. */
export function describeNoRow(title: string, top: readonly string[]): string {
  return (
    `no command is titled exactly "${title}"` +
    (top.length > 0
      ? `; the palette shows:\n${top.map((label) => `  ${label}`).join('\n')}`
      : '; the palette shows nothing')
  );
}

export type FocusStep = 'enter' | 'down' | 'unreachable';

/**
 * What to do with the list as it is now: press Enter if the focus is on the row with the title, else
 * move down, and give up after as many steps as there are rows (the list wraps around).
 */
export function nextFocusStep(
  rows: readonly PaletteRow[],
  title: string,
  stepsTaken: number,
): FocusStep {
  if (rows.find(({ focused }) => focused)?.label === title) return 'enter';
  return stepsTaken >= rows.length ? 'unreachable' : 'down';
}

export function samePalette(a: PaletteState, b: PaletteState): boolean {
  return (
    a.value === b.value &&
    a.rows.length === b.rows.length &&
    a.rows.every((row, i) => row.label === b.rows[i]?.label && row.focused === b.rows[i]?.focused)
  );
}

/**
 * Whether the list can be trusted: the input has the text that was typed (VS Code puts `>` in front
 * for commands), and the last two reads are the same. Right after typing, the list may still be the
 * unfiltered one, and it filters a moment later.
 */
export function isSettled(
  previous: PaletteState | undefined,
  now: PaletteState,
  title: string,
): boolean {
  return now.value === `>${title}` && previous !== undefined && samePalette(previous, now);
}
