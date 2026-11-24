import { describe, expect, it } from 'vitest';
import { OPTIONAL_FILES, REQUIRED_FILES, compareListing } from '../../scripts/check-vsix.mjs';

describe('compareListing', () => {
  it('accepts exactly the required files', () => {
    expect(compareListing(['b', 'a'], ['a', 'b'], [])).toEqual({ missing: [], unexpected: [] });
  });

  it('reports every missing file, sorted', () => {
    expect(compareListing(['c'], ['c', 'b', 'a'], [])).toEqual({
      missing: ['a', 'b'],
      unexpected: [],
    });
  });

  it('reports every unexpected file, sorted', () => {
    expect(compareListing(['a', 'z', 'y'], ['a'], [])).toEqual({
      missing: [],
      unexpected: ['y', 'z'],
    });
  });

  it('reports missing and unexpected files together', () => {
    expect(compareListing(['a', 'x'], ['a', 'b'], [])).toEqual({
      missing: ['b'],
      unexpected: ['x'],
    });
  });

  it('allows optional files to be present or absent', () => {
    expect(compareListing(['a', 'opt'], ['a'], ['opt'])).toEqual({ missing: [], unexpected: [] });
    expect(compareListing(['a'], ['a'], ['opt'])).toEqual({ missing: [], unexpected: [] });
  });

  it('ignores directory entries', () => {
    expect(compareListing(['a', 'dir/'], ['a'], [])).toEqual({ missing: [], unexpected: [] });
  });

  it('does not treat duplicates as a different set', () => {
    expect(compareListing(['a', 'a'], ['a'], [])).toEqual({ missing: [], unexpected: [] });
  });
});

describe('expected vsix contents', () => {
  it('requires the manifest, bundles, media, readme, license and vsce metadata', () => {
    expect([...REQUIRED_FILES].sort()).toEqual(
      [
        '[Content_Types].xml',
        'extension.vsixmanifest',
        'extension/LICENSE.txt',
        'extension/dist/extension.js',
        'extension/dist/webview.js',
        'extension/media/icon.svg',
        'extension/media/window.css',
        'extension/package.json',
        'extension/readme.md',
      ].sort(),
    );
  });

  it('treats only the changelog as optional', () => {
    expect(OPTIONAL_FILES).toEqual(['extension/changelog.md']);
  });
});
