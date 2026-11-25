import { describe, expect, it } from 'vitest';
import { sessionEnv } from '../../../scripts/live/environment.ts';
import { HOME, TEMP } from '../../../scripts/live/session.ts';

describe('sessionEnv', () => {
  it('has its own home and temporary directories', () => {
    expect(
      sessionEnv({
        PATH: '/usr/bin',
        HOME: '/home/a',
        TMPDIR: '/var/tmp',
        XDG_RUNTIME_DIR: '/run',
      }),
    ).toEqual({ PATH: '/usr/bin', HOME, TMPDIR: TEMP, XDG_RUNTIME_DIR: TEMP });
  });

  it('passes the path, language, time zone and user', () => {
    const env = {
      PATH: '/usr/bin',
      LANG: 'de_DE.UTF-8',
      LC_ALL: 'C',
      LC_CTYPE: 'C.UTF-8',
      TZ: 'Europe/Berlin',
      USER: 'a',
    };
    expect(sessionEnv(env)).toEqual({ ...env, HOME, TMPDIR: TEMP, XDG_RUNTIME_DIR: TEMP });
  });

  it("is only the session's own with an empty caller environment", () => {
    expect(sessionEnv({})).toEqual({ HOME, TMPDIR: TEMP, XDG_RUNTIME_DIR: TEMP });
  });

  it.each([
    // Credentials, under any name.
    'NPM_TOKEN',
    'npm_config__authToken',
    'OPENAI_API_KEY',
    'CLIENT_SECRET',
    'SSH_AUTH_SOCK',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'REMOTE_CONTAINERS_IPC',
    'GIT_ASKPASS',
    'DB_PASSWORD',
    'AWS_ACCESS_KEY',
    'MY_CREDENTIALS',
    'DATABASE_URL',
    // What changes how VS Code, Node or the display start.
    'NODE_OPTIONS',
    'NODE_PATH',
    'NODE_EXTRA_CA_CERTS',
    'VSCODE_PID',
    'ELECTRON_RUN_AS_NODE',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XDG_CONFIG_HOME',
    'XDG_SESSION_TYPE',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'SHELL',
    'LOGNAME',
    'MYLC_ALL',
  ])('does not pass %s', (name) => {
    expect(sessionEnv({ [name]: 'x' })).not.toHaveProperty(name);
  });
});
