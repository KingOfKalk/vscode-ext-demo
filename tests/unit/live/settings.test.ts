import { describe, expect, it } from 'vitest';
import {
  describeChange,
  mergeSetting,
  parseSettingValue,
  readSetting,
  SettingsError,
  validateSettingKey,
} from '../../../scripts/live/settings.ts';

describe('mergeSetting', () => {
  it('adds a key', () => {
    const merged = mergeSetting('{\n  "a": 1\n}\n', 'vscodeExtDemo.step', 5);
    expect(JSON.parse(merged)).toEqual({ a: 1, 'vscodeExtDemo.step': 5 });
  });

  it('replaces a key and keeps its place and all others', () => {
    const merged = mergeSetting('{"a": 1, "b": "x", "c": [1]}', 'b', { deep: true });
    expect(JSON.parse(merged)).toEqual({ a: 1, b: { deep: true }, c: [1] });
    expect(Object.keys(JSON.parse(merged) as object)).toEqual(['a', 'b', 'c']);
  });

  it('writes two spaces and a final newline, like VS Code', () => {
    expect(mergeSetting('{}', 'a', 1)).toBe('{\n  "a": 1\n}\n');
  });

  it('starts from an empty file', () => {
    expect(JSON.parse(mergeSetting('', 'a', 'x'))).toEqual({ a: 'x' });
    expect(JSON.parse(mergeSetting(' \n', 'a', 'x'))).toEqual({ a: 'x' });
  });

  it('keeps null, false, 0 and "" as values', () => {
    const merged = JSON.parse(mergeSetting('{}', 'a', null)) as Record<string, unknown>;
    expect(merged).toEqual({ a: null });
    expect(JSON.parse(mergeSetting('{}', 'a', false))).toEqual({ a: false });
    expect(JSON.parse(mergeSetting('{}', 'a', 0))).toEqual({ a: 0 });
    expect(JSON.parse(mergeSetting('{}', 'a', ''))).toEqual({ a: '' });
  });

  it('takes a key named like a prototype property as a key', () => {
    const merged = mergeSetting('{}', '__proto__', { x: 1 });
    const parsed = JSON.parse(merged) as object;
    expect(Object.keys(parsed)).toEqual(['__proto__']);
    expect(({} as { x?: number }).x).toBeUndefined();
  });

  it('throws on invalid JSON, and names comments as the likely cause', () => {
    expect(() => mergeSetting('{ "a": 1,', 'b', 1)).toThrow(SettingsError);
    expect(() => mergeSetting('{ // note\n "a": 1 }', 'b', 1)).toThrow(/comments/);
    expect(() => mergeSetting('not json', 'b', 1)).toThrow(/not valid JSON/);
  });

  it('throws if the file is JSON but not an object', () => {
    expect(() => mergeSetting('[1]', 'b', 1)).toThrow(/object/);
    expect(() => mergeSetting('null', 'b', 1)).toThrow(/object/);
    expect(() => mergeSetting('"x"', 'b', 1)).toThrow(/object/);
  });

  it('throws on a value that JSON cannot hold', () => {
    expect(() => mergeSetting('{}', 'a', undefined)).toThrow(/JSON/);
  });
});

describe('readSetting', () => {
  it('tells a missing key from one that is null', () => {
    expect(readSetting('{"a": null}', 'a')).toEqual({ found: true, value: null });
    expect(readSetting('{"a": null}', 'b')).toEqual({ found: false });
    expect(readSetting('', 'b')).toEqual({ found: false });
  });

  it('does not find a key of the prototype', () => {
    expect(readSetting('{}', 'toString')).toEqual({ found: false });
  });

  it('throws on invalid JSON', () => {
    expect(() => readSetting('{', 'a')).toThrow(SettingsError);
  });
});

describe('parseSettingValue', () => {
  it('parses JSON', () => {
    expect(parseSettingValue('5')).toBe(5);
    expect(parseSettingValue('"Hi"')).toBe('Hi');
    expect(parseSettingValue('true')).toBe(true);
    expect(parseSettingValue('null')).toBeNull();
    expect(parseSettingValue('{"a":[1]}')).toEqual({ a: [1] });
  });

  it('says that a text needs quotes', () => {
    expect(() => parseSettingValue('Hi')).toThrow(/Hi is not JSON.*quotes/);
    expect(() => parseSettingValue('')).toThrow(/not JSON/);
    expect(() => parseSettingValue("'Hi'")).toThrow(/not JSON/);
  });
});

describe('validateSettingKey', () => {
  it('accepts the keys of the extension and VS Code', () => {
    for (const key of [
      'vscodeExtDemo.message',
      'editor.fontSize',
      '[markdown]',
      'workbench.colorTheme',
    ]) {
      expect(() => {
        validateSettingKey(key);
      }).not.toThrow();
    }
  });

  it('rejects an empty key, spaces, quotes, backslashes and control characters', () => {
    for (const key of ['', ' ', 'a b', ' a', 'a ', 'a"b', "a'b", 'a`b', 'a\\b', 'a\tb', 'a\nb']) {
      expect(() => {
        validateSettingKey(key);
      }).toThrow(SettingsError);
    }
  });
});

describe('describeChange', () => {
  it('shows the old and the new value as JSON', () => {
    expect(describeChange('vscodeExtDemo.step', { found: true, value: 1 }, 5)).toBe(
      'vscodeExtDemo.step: 1 -> 5',
    );
    expect(describeChange('m', { found: true, value: 'a' }, 'Hi')).toBe('m: "a" -> "Hi"');
  });

  it('says that the key was not set before', () => {
    expect(describeChange('m', { found: false }, 'Hi')).toBe('m: (not set) -> "Hi"');
  });

  it('says that nothing changed', () => {
    expect(describeChange('m', { found: true, value: { a: [1] } }, { a: [1] })).toBe(
      'm: {"a":[1]} (unchanged)',
    );
  });
});
