import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export function dataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FOGGY_DATA_DIR !== undefined && !env.FOGGY_DATA_DIR.trim())
    throw new Error('FOGGY_DATA_DIR must not be empty.');
  return resolve(env.FOGGY_DATA_DIR ?? join(homedir(), '.local', 'share', 'foggybrain'));
}

export function pidFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDirectory(env), 'foggy.pid');
}

export function logFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDirectory(env), 'foggy.log');
}

export function serverOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.FOGGY_PORT ?? '4173';
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('FOGGY_PORT must be an integer between 1 and 65535.');
  return `http://127.0.0.1:${port}`;
}

export function serverEntry(): { command: string; args: string[] } {
  const source = import.meta.url.endsWith('.ts');
  const entry = fileURLToPath(new URL(source ? './server.ts' : './server.js', import.meta.url));
  // A source checkout has no compiled server to spawn, so run it through tsx.
  return { command: process.execPath, args: source ? ['--import', 'tsx', entry] : [entry] };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function readRunningPid(env: NodeJS.ProcessEnv = process.env): Promise<number | null> {
  let text: string;
  try {
    text = await readFile(pidFilePath(env), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const pid = Number(trimmed);
  return pid > 0 && alive(pid) ? pid : null;
}

async function answersHealth(url: string): Promise<boolean> {
  const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) }).catch(
    () => null,
  );
  return response?.ok === true;
}

async function logTail(path: string, lines = 20): Promise<string> {
  const text = await readFile(path, 'utf8').catch(() => '');
  const kept = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-lines);
  return kept.join('\n');
}

export interface StartOptions {
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof spawn;
  probe?: (url: string) => Promise<boolean>;
  readyTimeoutMs?: number;
}

export async function startServer(
  options: StartOptions = {},
): Promise<{ pid: number; url: string; dataDir: string }> {
  const env = options.env ?? process.env;
  const running = await readRunningPid(env);
  if (running !== null)
    throw new Error(`Foggybrain is already running (pid ${running}). Run foggy stop first.`);
  const dataDir = dataDirectory(env);
  const url = serverOrigin(env);
  await mkdir(dataDir, { recursive: true });
  const logPath = logFilePath(env);
  // The child's own log file, rather than a pipe: a detached server outlives this process and
  // would eventually block on a pipe nobody drains.
  const log = await open(logPath, 'w');
  const { command, args } = serverEntry();
  let child: ReturnType<typeof spawn>;
  try {
    child = (options.spawnImpl ?? spawn)(command, args, {
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env,
    });
  } finally {
    await log.close();
  }
  if (typeof child.pid !== 'number')
    throw new Error('Could not start the Foggybrain server: no child process ID.');
  child.unref();

  const exit: { status: string | null } = { status: null };
  child.once('exit', (code, signal) => {
    exit.status = signal !== null ? `killed by ${signal}` : `exit code ${code}`;
  });
  const probe = options.probe ?? answersHealth;
  const deadline = Date.now() + (options.readyTimeoutMs ?? 20_000);
  let ready = false;
  for (;;) {
    // A dead child never counts as ready, however healthy the port looks: on a port collision the
    // answer comes from whoever already owns it.
    if (exit.status !== null) break;
    ready = await probe(url);
    if (ready || Date.now() >= deadline) break;
    await delay(100);
  }
  if (exit.status !== null) ready = false;
  if (!ready) {
    if (exit.status === null) {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        // Already gone; the failure below is what matters.
      }
    }
    const reason = exit.status === null ? 'it never answered' : `it stopped (${exit.status})`;
    const tail = await logTail(logPath);
    throw new Error(
      `The Foggybrain server did not start on ${url}: ${reason}. See ${logPath}${tail === '' ? '.' : `:\n${tail}`}`,
    );
  }

  await writeFile(pidFilePath(env), `${child.pid}\n`);
  return { pid: child.pid, url, dataDir };
}

export async function stopServer(
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ stopped: boolean; pid: number | null }> {
  const env = options.env ?? process.env;
  const pid = await readRunningPid(env);
  const remove = () => rm(pidFilePath(env), { force: true });
  if (pid === null) {
    await remove();
    return { stopped: false, pid: null };
  }
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  while (alive(pid) && Date.now() < deadline) await delay(100);
  if (alive(pid))
    throw new Error(
      `Foggybrain (pid ${pid}) did not exit after SIGTERM. Inspect it before retrying.`,
    );
  await remove();
  return { stopped: true, pid };
}
