import { describe, expect, it } from 'vitest';
import { describeReinstall, hashOf } from '../../../scripts/live/reload.ts';

const files = (state: Record<string, [string | undefined, string, string]>) =>
  Object.entries(state).map(([file, [before, built, after]]) => ({ file, before, built, after }));

describe('hashOf', () => {
  it('is the same for the same bytes only', () => {
    expect(hashOf(Buffer.from('a'))).toBe(hashOf(Buffer.from('a')));
    expect(hashOf(Buffer.from('a'))).not.toBe(hashOf(Buffer.from('b')));
    expect(hashOf(Buffer.from('a'))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('describeReinstall', () => {
  it('names the files that changed and those that did not', () => {
    const text = describeReinstall(
      files({
        'dist/extension.js': ['a', 'b', 'b'],
        'dist/webview.js': ['c', 'c', 'c'],
        'media/window.css': ['d', 'd', 'd'],
      }),
    );
    expect(text).toEqual({
      changed: ['dist/extension.js'],
      same: ['dist/webview.js', 'media/window.css'],
    });
  });

  it('says nothing changed if the build is the installed one', () => {
    expect(describeReinstall(files({ 'dist/extension.js': ['a', 'a', 'a'] }))).toEqual({
      changed: [],
      same: ['dist/extension.js'],
    });
  });

  it('counts a file that was not installed before as changed', () => {
    expect(describeReinstall(files({ 'media/new.css': [undefined, 'x', 'x'] })).changed).toEqual([
      'media/new.css',
    ]);
  });

  it('fails if an installed file is not the built one', () => {
    expect(() => describeReinstall(files({ 'dist/extension.js': ['a', 'b', 'a'] }))).toThrow(
      /dist\/extension\.js.*not the one that was built/,
    );
  });

  it('fails if an installed file is neither the old nor the built one', () => {
    expect(() => describeReinstall(files({ 'dist/webview.js': ['a', 'b', 'c'] }))).toThrow(
      /dist\/webview\.js/,
    );
  });
});
