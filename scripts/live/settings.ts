// `set <setting> <json>`: the decisions on plain text and values. Pure; the file and the session are in set.ts.

/** The key, the value or the file is wrong; the text says why, in one line. */
export class SettingsError extends Error {
  override name = 'SettingsError';
}

/** What a read finds: a key that is set to null is found. */
export type Found = { found: false } | { found: true; value: unknown };

/** A key of the user settings: any, as long as it stays one JSON string without surprises. */
export function validateSettingKey(key: string): void {
  // eslint-disable-next-line no-control-regex -- control characters are what this looks for
  if (key === '' || /[\s"'`\\\u0000-\u001f\u007f]/u.test(key)) {
    throw new SettingsError(
      `"${key}" is not a setting key: no spaces, quotes, backslashes or control characters`,
    );
  }
}

/** The value of `set`, which is JSON: a text needs quotes of its own. */
export function parseSettingValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SettingsError(`${text} is not JSON; a text needs quotes of its own: '"text"'`);
  }
}

function parseSettings(json: string): Record<string, unknown> {
  if (json.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new SettingsError(
      `settings.json is not valid JSON (${error instanceof Error ? error.message : String(error)}); ` +
        'comments and trailing commas are not supported by `set`: edit the file by hand',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SettingsError('settings.json is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * The text of settings.json with `key` set to `value`; the other keys, and the place of this one if
 * it is there, stay. The file is written again as VS Code does: two spaces and a final newline.
 * @throws SettingsError if the file is not valid JSON (comments are not supported) or not an object
 */
export function mergeSetting(json: string, key: string, value: unknown): string {
  const settings = parseSettings(json);
  // JSON.stringify drops a key without a JSON form (undefined, a function) without saying so.
  if (JSON.stringify(value) === undefined) throw new SettingsError('the value has no JSON form');
  return `${JSON.stringify({ ...settings, [key]: value }, undefined, 2)}\n`;
}

/** What `key` is in the file now. */
export function readSetting(json: string, key: string): Found {
  const settings = parseSettings(json);
  return Object.hasOwn(settings, key) ? { found: true, value: settings[key] } : { found: false };
}

/** One line: the old and the new value, or that nothing changed. */
export function describeChange(key: string, old: Found, value: unknown): string {
  const now = JSON.stringify(value);
  if (!old.found) return `${key}: (not set) -> ${now}`;
  const before = JSON.stringify(old.value);
  return before === now ? `${key}: ${now} (unchanged)` : `${key}: ${before} -> ${now}`;
}

export interface Applied {
  /** False if the extension does not have the setting at all. */
  ok: boolean;
  text: string;
}

/**
 * What the extension reports after `key` was written: its settings as it logged them. The log shows
 * the value the extension uses, which is not always the one written (it limits a step that is too
 * big), so both are compared and said.
 * @param prefix the section of the extension, like `vscodeExtDemo.`
 * @param seen the settings of the log line, undefined if the line could not be read
 */
export function describeApplied(
  key: string,
  prefix: string,
  written: unknown,
  seen: Record<string, unknown> | undefined,
): Applied {
  if (seen === undefined) {
    return {
      ok: true,
      text: 'the extension saw a settings change, but its log line is not readable',
    };
  }
  const name = key.slice(prefix.length);
  if (!Object.hasOwn(seen, name)) {
    return {
      ok: false,
      text: `the extension saw a settings change, but it has no setting "${name}" (it has: ${Object.keys(seen).join(', ')})`,
    };
  }
  const now = JSON.stringify(seen[name]);
  const sent = JSON.stringify(written);
  return {
    ok: true,
    text:
      now === sent
        ? `the extension now has ${name} = ${now}`
        : `the extension now has ${name} = ${now}, not ${sent}: it uses its own limit or default`,
  };
}
