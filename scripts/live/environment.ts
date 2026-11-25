// The environment of everything the session starts.
import { cleanEnv } from '../vscode-run.mjs';
import { HOME, TEMP } from './session.ts';

/** Credentials: whoever watches the session can open a terminal in it. */
const SECRETS = /_(TOKEN|API_KEY|SECRET)$|^(SSH_AUTH_SOCK$|GH_|GITHUB_)/i;

/** VS Code puts sockets and caches into the temporary directories. */
export function sessionEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const kept = Object.entries(env).filter(([name]) => !SECRETS.test(name));
  return { ...cleanEnv(HOME, Object.fromEntries(kept)), TMPDIR: TEMP, XDG_RUNTIME_DIR: TEMP };
}
