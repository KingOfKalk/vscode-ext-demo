// The environment of everything the session starts.
import { cleanEnv } from '../vscode-run.mjs';
import { HOME, TEMP } from './session.ts';

/**
 * Credentials, and the sockets and helpers that reach them: whoever watches the session can open a
 * terminal in it. Names that only contain a word (`KEYBOARD`, `TOKENS`) stay.
 */
const SECRETS =
  /_(TOKEN|API_KEY|SECRET|KEY|PASSWORD)$|^(TOKEN|PASSWORD|SSH_AUTH_SOCK|SSH_ASKPASS|GIT_ASKPASS)$|^(GH_|GITHUB_|REMOTE_CONTAINERS)/i;

/** VS Code puts sockets and caches into the temporary directories. */
export function sessionEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const kept = Object.entries(env).filter(([name]) => !SECRETS.test(name));
  return { ...cleanEnv(HOME, Object.fromEntries(kept)), TMPDIR: TEMP, XDG_RUNTIME_DIR: TEMP };
}
