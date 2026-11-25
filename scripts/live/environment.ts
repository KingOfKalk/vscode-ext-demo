// The environment of everything the session starts.
import { HOME, TEMP } from './session.ts';

/**
 * What passes from the caller: where to find programs, the language and time zone, and who runs
 * it. Everything else stays out, so a terminal opened in the session (and `eval process.env`) shows
 * no credential of the caller, and no setting of a surrounding VS Code or Node. The session itself
 * adds `HOME`, `TMPDIR`, `XDG_RUNTIME_DIR` and, for what needs a screen, `DISPLAY`.
 */
const PASSED = /^(PATH|LANG|TZ|USER)$|^LC_/;

/** VS Code puts sockets and caches into the temporary directories, so they are the session's own. */
export function sessionEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const kept = Object.entries(env).filter(([name]) => PASSED.test(name));
  return { ...Object.fromEntries(kept), HOME, TMPDIR: TEMP, XDG_RUNTIME_DIR: TEMP };
}
