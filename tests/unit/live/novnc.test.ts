import { describe, expect, it } from 'vitest';
import {
  isLoopback,
  novncAddress,
  novncUrl,
  readNovncConfig,
} from '../../../scripts/live/novnc.ts';

describe('readNovncConfig', () => {
  it('binds to 127.0.0.1:6080 by default', () => {
    expect(readNovncConfig({})).toEqual({ host: '127.0.0.1', port: 6080 });
    expect(readNovncConfig({ LIVE_NOVNC_HOST: '', LIVE_NOVNC_PORT: '' })).toEqual({
      host: '127.0.0.1',
      port: 6080,
    });
  });

  it('takes the address from the environment', () => {
    expect(readNovncConfig({ LIVE_NOVNC_HOST: '0.0.0.0', LIVE_NOVNC_PORT: '16080' })).toEqual({
      host: '0.0.0.0',
      port: 16080,
    });
  });

  it.each(['localhost', '127.0.0.1:1', 'a b', '--web=/'])('refuses the host %j', (host) => {
    expect(() => readNovncConfig({ LIVE_NOVNC_HOST: host })).toThrow('LIVE_NOVNC_HOST');
  });

  it.each(['0', '65536', '-1', '6080x', '1e3', ' 6080'])('refuses the port %j', (port) => {
    expect(() => readNovncConfig({ LIVE_NOVNC_PORT: port })).toThrow('LIVE_NOVNC_PORT');
  });

  it.each(['9222', '9229', '5900'])('refuses the port %s of the session itself', (port) => {
    expect(() => readNovncConfig({ LIVE_NOVNC_PORT: port })).toThrow('LIVE_NOVNC_PORT');
  });
});

describe('isLoopback', () => {
  it.each(['127.0.0.1', '127.0.1.1', '::1'])('%s', (host) => {
    expect(isLoopback(host)).toBe(true);
  });

  it.each(['0.0.0.0', '::', '192.168.1.2', '172.17.0.2'])('not %s', (host) => {
    expect(isLoopback(host)).toBe(false);
  });
});

describe('novncAddress', () => {
  it('puts an IPv6 address in brackets', () => {
    expect(novncAddress({ host: '127.0.0.1', port: 6080 })).toBe('127.0.0.1:6080');
    expect(novncAddress({ host: '::1', port: 6080 })).toBe('[::1]:6080');
  });
});

describe('novncUrl', () => {
  it('has the token in the fragment, which is in no request for the page', () => {
    const url = new URL(novncUrl({ host: '127.0.0.1', port: 6080 }, 'abc'));
    expect(url.origin + url.pathname + url.search).toBe('http://127.0.0.1:6080/vnc.html');
    const settings = new URLSearchParams(url.hash.slice(1));
    expect(settings.get('path')).toBe('websockify?token=abc');
    expect(settings.get('autoconnect')).toBe('true');
  });

  it.each([
    ['0.0.0.0', 'http://127.0.0.1:6080/'],
    ['::', 'http://[::1]:6080/'],
    ['::1', 'http://[::1]:6080/'],
    ['172.17.0.2', 'http://172.17.0.2:6080/'],
  ])('can be opened if the host is %s', (host, start) => {
    expect(novncUrl({ host, port: 6080 }, 'abc').startsWith(start)).toBe(true);
  });
});
