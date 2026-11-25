// Processes that outlive this script. /proc says what runs: `kill(pid, 0)` also finds a process
// that ended and that nobody has waited for, which is common in containers.
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { killGroup } from '../vscode-run.mjs';

export type ProcessName = 'start' | 'xvfb' | 'openbox' | 'x11vnc' | 'novnc' | 'vscode';

/** The first process of a group. The start time tells it from a later one with the same ID. */
export interface ProcessInfo {
  name: ProcessName;
  pid: number;
  started: string;
}

interface Stat {
  state: string;
  group: number;
  started: string;
}

/** Reads `/proc/<pid>/stat`. The name in parentheses may hold anything. */
export function parseStat(text: string): Stat {
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
  return { state: fields[0] ?? '', group: Number(fields[2]), started: fields[19] ?? '' };
}

/** Of a process that has not ended. */
function readStat(pid: number): Stat | undefined {
  try {
    const stat = parseStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    return stat.state === 'Z' || stat.state === 'X' ? undefined : stat;
  } catch {
    return undefined; // No such process.
  }
}

export function identify(name: ProcessName, pid: number): ProcessInfo {
  const stat = readStat(pid);
  if (!stat) throw new Error(`${name} ended right after its start`);
  return { name, pid, started: stat.started };
}

/**
 * Identifies this run of the system or container: the process IDs of another one mean nothing.
 */
export function bootId(): string {
  const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  return `${boot}/${parseStat(readFileSync('/proc/1/stat', 'utf8')).started}`;
}

export function leaderRuns({ pid, started }: ProcessInfo): boolean {
  return readStat(pid)?.started === started;
}

/** Whether the first process or anything else in its group runs. */
export function groupRuns({ pid, started }: ProcessInfo): boolean {
  const leader = readStat(pid);
  if (leader) return leader.started === started;
  return readdirSync('/proc').some(
    (entry) => /^\d+$/.test(entry) && readStat(Number(entry))?.group === pid,
  );
}

/**
 * Ends the first process of a group with SIGTERM and waits until the whole group is gone. Only the
 * first one: VS Code saves its state with the help of the others. What is left after `graceMs` gets
 * SIGKILL.
 */
export async function stopGroup(info: ProcessInfo, graceMs: number): Promise<'stopped' | 'killed'> {
  const gone = () => !groupRuns(info) || undefined;
  if (gone()) return 'stopped';
  try {
    if (leaderRuns(info)) process.kill(info.pid, 'SIGTERM');
    else killGroup(info.pid, 'SIGTERM');
  } catch {
    // Gone in between.
  }
  try {
    await waitFor(`${info.name} ends`, gone, { timeoutMs: graceMs });
    return 'stopped';
  } catch {
    killGroup(info.pid);
    await waitFor(`${info.name} ends after SIGKILL`, gone, { timeoutMs: 5000 });
    return 'killed';
  }
}

export interface WaitOptions {
  timeoutMs: number;
  pauseMs?: number;
  signal?: AbortSignal | undefined;
}

/** Waits until `attempt` returns something; an error it throws ends the wait. */
export async function waitFor<T>(
  what: string,
  attempt: () => T | undefined | Promise<T | undefined>,
  { timeoutMs, pauseMs = 100, signal }: WaitOptions,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    const value = await attempt();
    if (value !== undefined) return value;
    if (Date.now() > end) {
      throw new Error(`waited ${timeoutMs / 1000} s, but this did not happen: ${what}`);
    }
    await sleep(pauseMs, undefined, { signal }).catch(() => undefined);
  }
}

/** Throws, naming the port, if something listens there already. */
export async function assertPortFree(use: string, host: string, port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      const reason = error.code === 'EADDRINUSE' ? 'is taken' : `cannot be used (${error.message})`;
      reject(new Error(`port ${port} (${use}, ${host}) ${reason}`));
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => {
        resolve();
      });
    });
  });
}
