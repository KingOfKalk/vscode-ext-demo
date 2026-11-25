// Where the owner watches the session: the address of noVNC and its URL.
import { isIP } from 'node:net';

/** VS Code: Chrome DevTools protocol of the window, and Node inspector of the extension host. */
export const DEBUG_PORT = 9222;
export const INSPECT_PORT = 9229;
export const VNC_PORT = 5900;

export interface NovncConfig {
  host: string;
  port: number;
}

/**
 * The address noVNC listens on. The default is for this machine only; `LIVE_NOVNC_HOST` is for a
 * container whose port is published to the localhost of its host.
 */
export function readNovncConfig(env: NodeJS.ProcessEnv): NovncConfig {
  const host = env.LIVE_NOVNC_HOST || '127.0.0.1';
  const portText = env.LIVE_NOVNC_PORT || '6080';
  if (isIP(host) === 0) {
    throw new Error(`LIVE_NOVNC_HOST is ${JSON.stringify(host)}, expected an IP address`);
  }
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
    throw new Error(`LIVE_NOVNC_PORT is ${JSON.stringify(portText)}, expected 1 to 65535`);
  }
  if ([DEBUG_PORT, INSPECT_PORT, VNC_PORT].includes(port)) {
    throw new Error(`LIVE_NOVNC_PORT is ${portText}, which the session uses itself`);
  }
  return { host, port };
}

export function isLoopback(host: string): boolean {
  return host === '::1' || host.startsWith('127.');
}

/** The host as it stands in front of a port. */
function inAddress(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}

export function novncAddress({ host, port }: NovncConfig): string {
  return `${inAddress(host)}:${port}`;
}

/** The page that shows the session. A bind to all addresses is reachable on the loopback one. */
export function novncUrl({ host, port }: NovncConfig, token: string): string {
  const reachable = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  const settings = new URLSearchParams({
    autoconnect: 'true',
    reconnect: 'true',
    resize: 'scale',
    path: `websockify?token=${token}`,
  });
  return `http://${novncAddress({ host: reachable, port })}/vnc.html#${settings.toString()}`;
}
