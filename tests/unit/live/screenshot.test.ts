import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { screenshotPath, timestampName } from '../../../scripts/live/screenshot.ts';

const DIR = '/work/.vscode-live';
const NOW = new Date('2026-11-25T06:37:40.683Z');

describe('screenshotPath', () => {
  it('puts a named file into the directory', () => {
    expect(screenshotPath('after-click_3', NOW, DIR)).toBe(join(DIR, 'after-click_3.png'));
  });

  it('names an unnamed one after the time, without colons and dots', () => {
    expect(timestampName(NOW)).toBe('2026-11-25T06-37-40-683Z');
    expect(screenshotPath(undefined, NOW, DIR)).toBe(join(DIR, '2026-11-25T06-37-40-683Z.png'));
  });

  it.each([
    '',
    '..',
    '../x',
    'a/b',
    'a\\b',
    '/etc/passwd',
    '.hidden',
    'x.png',
    '-rf',
    'a b',
    'a\0b',
    'a\nb',
    '~/x',
  ])('rejects the name %j', (name) => {
    expect(() => screenshotPath(name, NOW, DIR)).toThrow(/not a name/);
  });
});
