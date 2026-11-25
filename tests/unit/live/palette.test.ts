import { describe, expect, it } from 'vitest';
import {
  describeNoRow,
  isSettled,
  nextFocusStep,
  pickRow,
  samePalette,
  type PaletteRow,
  type PaletteState,
} from '../../../scripts/live/palette.ts';

function rows(labels: string[], focused = 0): PaletteRow[] {
  return labels.map((label, i) => ({ label, focused: i === focused }));
}

describe('pickRow', () => {
  it('finds the row with exactly the title', () => {
    expect(
      pickRow(rows(['Demo: Open Window', 'Demo: Focus on Demo View']), 'Demo: Open Window'),
    ).toEqual({
      kind: 'one',
      index: 0,
    });
    expect(pickRow(rows(['Other', 'Demo: Open Window']), 'Demo: Open Window')).toEqual({
      kind: 'one',
      index: 1,
    });
  });

  it('does not take a row that contains the title, or that the title contains', () => {
    expect(pickRow(rows(['Demo: Open Window to the Side']), 'Demo: Open Window').kind).toBe('none');
    expect(pickRow(rows(['Open']), 'Demo: Open Window').kind).toBe('none');
    expect(pickRow(rows(['demo: open window']), 'Demo: Open Window').kind).toBe('none');
    expect(pickRow(rows([' Demo: Open Window']), 'Demo: Open Window').kind).toBe('none');
  });

  it('lists the first five rows when there is no such row', () => {
    const labels = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    expect(pickRow(rows(labels), 'x')).toEqual({ kind: 'none', top: ['a', 'b', 'c', 'd', 'e'] });
    expect(pickRow([], 'x')).toEqual({ kind: 'none', top: [] });
  });

  it('says so if two rows have the title', () => {
    expect(pickRow(rows(['x', 'x']), 'x')).toEqual({ kind: 'several', count: 2 });
  });

  it('words the error', () => {
    expect(describeNoRow('Demo: Nope', ['a', 'b'])).toBe(
      'no command is titled exactly "Demo: Nope"; the palette shows:\n  a\n  b',
    );
    expect(describeNoRow('x', [])).toBe(
      'no command is titled exactly "x"; the palette shows nothing',
    );
  });
});

describe('nextFocusStep', () => {
  const list = ['a', 'b', 'target', 'd'];

  it('presses Enter only when the focus is on the title', () => {
    expect(nextFocusStep(rows(list, 2), 'target', 0)).toBe('enter');
    expect(nextFocusStep(rows(list, 0), 'target', 0)).toBe('down');
    expect(nextFocusStep(rows(list, 3), 'target', 1)).toBe('down');
  });

  it('does not press Enter when the title is in the list but not in focus', () => {
    // Title in the list, focus on another row: never Enter.
    expect(nextFocusStep(rows(['target', 'other'], 1), 'target', 0)).not.toBe('enter');
  });

  it('moves down when nothing has the focus', () => {
    expect(
      nextFocusStep(
        list.map((label) => ({ label, focused: false })),
        'target',
        0,
      ),
    ).toBe('down');
  });

  it('gives up after as many steps as there are rows', () => {
    expect(nextFocusStep(rows(list, 0), 'nope', 3)).toBe('down');
    expect(nextFocusStep(rows(list, 0), 'nope', 4)).toBe('unreachable');
    expect(nextFocusStep([], 'nope', 0)).toBe('unreachable');
  });
});

describe('isSettled', () => {
  const settled: PaletteState = { value: '>Demo: Open Window', rows: rows(['Demo: Open Window']) };

  it('needs two equal reads and the typed text', () => {
    expect(isSettled(undefined, settled, 'Demo: Open Window')).toBe(false);
    expect(isSettled(settled, { ...settled, rows: [...settled.rows] }, 'Demo: Open Window')).toBe(
      true,
    );
  });

  it('is not settled while the input has other text, however stable the list is', () => {
    const unfiltered: PaletteState = { value: '>', rows: rows(['Recent 1', 'Recent 2']) };
    expect(isSettled(unfiltered, unfiltered, 'Demo: Open Window')).toBe(false);
    const partial: PaletteState = { value: '>Demo: Open', rows: settled.rows };
    expect(isSettled(partial, partial, 'Demo: Open Window')).toBe(false);
  });

  it('is not settled while the list or its focus changes', () => {
    const other = { ...settled, rows: rows(['Demo: Open Window', 'Another']) };
    expect(isSettled(settled, other, 'Demo: Open Window')).toBe(false);
    const moved = { ...other, rows: rows(['Demo: Open Window', 'Another'], 1) };
    expect(isSettled(other, moved, 'Demo: Open Window')).toBe(false);
  });
});

describe('samePalette', () => {
  it('compares the text, the labels and the focus', () => {
    const a: PaletteState = { value: '>a', rows: rows(['x', 'y'], 0) };
    expect(samePalette(a, { value: '>a', rows: rows(['x', 'y'], 0) })).toBe(true);
    expect(samePalette(a, { value: '>b', rows: rows(['x', 'y'], 0) })).toBe(false);
    expect(samePalette(a, { value: '>a', rows: rows(['x', 'z'], 0) })).toBe(false);
    expect(samePalette(a, { value: '>a', rows: rows(['x', 'y'], 1) })).toBe(false);
    expect(samePalette(a, { value: '>a', rows: rows(['x']) })).toBe(false);
  });
});
