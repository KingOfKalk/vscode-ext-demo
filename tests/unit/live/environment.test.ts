import { describe, expect, it } from 'vitest';
import { sessionEnv } from '../../../scripts/live/environment.ts';
import { HOME, TEMP } from '../../../scripts/live/session.ts';

describe('sessionEnv', () => {
  it('has its own home and temporary directories', () => {
    expect(
      sessionEnv({ PATH: '/usr/bin', HOME: '/home/a', TMPDIR: '/var/tmp', VSCODE_PID: '1' }),
    ).toEqual({ PATH: '/usr/bin', HOME, TMPDIR: TEMP, XDG_RUNTIME_DIR: TEMP });
  });

  it.each([
    'NPM_TOKEN',
    'npm_config__token',
    'OPENAI_API_KEY',
    'CLIENT_SECRET',
    'SSH_AUTH_SOCK',
    'GH_TOKEN',
    'GH_HOST',
    'GITHUB_TOKEN',
    'GITHUB_ACTOR',
  ])('drops %s: a terminal of the session shows the environment', (name) => {
    expect(sessionEnv({ [name]: 'secret' })).not.toHaveProperty(name);
  });

  it.each(['TOKENS', 'GHOST', 'MY_GH_X', 'API_KEYBOARD', 'SECRET_SANTA'])('keeps %s', (name) => {
    expect(sessionEnv({ [name]: 'a' })).toHaveProperty(name, 'a');
  });
});
