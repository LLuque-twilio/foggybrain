import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createConnection, createServer, type Server } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

export const HEALTH_HEADER = 'X-Foggybrain-Protocol';
export const HEALTH_PROTOCOL = '1';

async function runtimeDirectory(create: boolean): Promise<string> {
  const directory = join(homedir(), '.local', 'state', 'foggybrain', 'instances');
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new Error(
      'Foggybrain instance registry must be a private directory owned by the current user.',
    );
  return directory;
}

export async function registerServer(origin: string, shutdown: () => Promise<void>) {
  const directory = await runtimeDirectory(true);
  const identity = randomUUID();
  const token = randomUUID();
  const record = join(directory, `${identity}.json`);
  const control = createServer((socket) => {
    socket.setEncoding('utf8');
    socket.setTimeout(20000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.write(`foggybrain-stop/1 ${identity}\n`);
    let input = '';
    socket.on('data', (chunk) => {
      input += chunk;
      if (input.length > 128) return socket.destroy();
      if (!input.includes('\n')) return;
      socket.removeAllListeners('data');
      if (input !== `stop ${token}\n`) return socket.destroy();
      void shutdown().then(
        () => socket.end(`stopped ${identity}\n`),
        () => socket.end('failed\n'),
      );
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      control.once('error', reject);
      control.listen(0, '127.0.0.1', () => {
        control.off('error', reject);
        resolve();
      });
    });
    const address = control.address();
    if (!address || typeof address === 'string') throw new Error('Missing control port.');
    await writeFile(
      `${record}.tmp`,
      JSON.stringify({ identity, token, port: address.port, origin }),
      {
        mode: 0o600,
        flag: 'wx',
      },
    );
    await rename(`${record}.tmp`, record);
  } catch (error) {
    control.close();
    await unlink(`${record}.tmp`).catch(() => {});
    throw error;
  }
  return async () => {
    control.close();
    // Each process owns a unique record; never unlink a port- or PID-keyed successor.
    await unlink(record).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  };
}

export async function stopLocalServers(): Promise<{ stopped: string[]; ignored: number }> {
  let directory: string;
  try {
    directory = await runtimeDirectory(false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { stopped: [], ignored: 0 };
    throw error;
  }
  const stopped: string[] = [];
  const failures: string[] = [];
  let ignored = 0;
  await Promise.all(
    (await readdir(directory))
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        let record;
        try {
          const path = join(directory, name);
          const info = await lstat(path);
          if (
            !info.isFile() ||
            info.uid !== process.getuid?.() ||
            (info.mode & 0o077) !== 0 ||
            info.size > 1024
          )
            throw new Error('Invalid record.');
          record = JSON.parse(await readFile(path, 'utf8'));
          if (
            !record ||
            !/^[0-9a-f-]{36}$/.test(record.identity) ||
            typeof record.token !== 'string' ||
            !/^[0-9a-f-]{36}$/.test(record.token) ||
            name !== `${record.identity}.json` ||
            !Number.isInteger(record.port) ||
            record.port < 1 ||
            record.port > 65535 ||
            typeof record.origin !== 'string' ||
            !/^http:\/\/127\.0\.0\.1:\d+$/.test(record.origin)
          )
            throw new Error('Invalid record.');
        } catch {
          ignored++;
          return;
        }
        const { identity, token, port, origin } = record;
        const outcome = await new Promise<'stopped' | 'ignored' | 'failed'>((resolve) => {
          const socket = createConnection({ host: '127.0.0.1', port });
          let verified = false;
          let input = '';
          const finish = (result: 'stopped' | 'ignored' | 'failed') => {
            socket.destroy();
            resolve(result);
          };
          const timer = setTimeout(() => finish('failed'), 20000);
          socket.setEncoding('utf8');
          socket.setTimeout(1000, () => {
            if (!verified) finish('failed');
          });
          socket.on('error', (error: NodeJS.ErrnoException) =>
            finish(!verified && error.code === 'ECONNREFUSED' ? 'ignored' : 'failed'),
          );
          socket.on('close', () => {
            clearTimeout(timer);
            finish(verified ? 'failed' : 'ignored');
          });
          socket.on('data', (chunk) => {
            input += chunk;
            if (input.length > 128) return finish(verified ? 'failed' : 'ignored');
            if (!input.includes('\n')) return;
            if (!verified) {
              if (input !== `foggybrain-stop/1 ${identity}\n`) return finish('ignored');
              verified = true;
              input = '';
              socket.write(`stop ${token}\n`);
            } else finish(input === `stopped ${identity}\n` ? 'stopped' : 'failed');
          });
        });
        if (outcome === 'stopped') stopped.push(origin);
        else if (outcome === 'ignored') ignored++;
        else failures.push(origin);
      }),
  );
  if (failures.length)
    throw new Error(
      `Shutdown unconfirmed for ${failures.sort().join(', ')}; stopped ${stopped.length} server(s), ignored ${ignored} record(s). No signals were sent. Inspect before retrying.`,
    );
  return { stopped: stopped.sort(), ignored };
}

export async function readUserEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Promise<NodeJS.ProcessEnv> {
  const directory = join(home, '.config', 'foggybrain');
  let configured: Record<string, string> = {};
  try {
    configured = parse(await readFile(join(directory, '.env')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const merged = { ...configured, ...env };
  if (merged.FOGGY_DATA_DIR?.trim())
    merged.FOGGY_DATA_DIR = resolve(directory, merged.FOGGY_DATA_DIR);
  return merged;
}

export async function resolveDefaultOrigin(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const configured = await readUserEnvironment(env);
  const port = configured.FOGGY_PORT ?? '4173';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error('FOGGY_PORT must be an integer between 1 and 65535.');
  return `http://127.0.0.1:${Number(port)}`;
}

// Kernel-owned locks need no stale-file deletion. Hash collisions only deny startup.
async function tryLock(key: string): Promise<Server | null> {
  const port = 20000 + (createHash('sha256').update(key).digest().readUInt32BE(0) % 45000);
  const server = createServer((socket) => socket.destroy());
  return new Promise((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(null);
      else reject(error);
    });
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(server));
  });
}

export async function lockDataDirectory(dataDir: string): Promise<Server> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lock = await tryLock(`foggybrain:data:${await realpath(dataDir)}`);
  if (!lock)
    throw new Error(
      'Foggybrain data directory is already locked. Stop the other server (possibly on another port). A local lock-port collision can also cause this error.',
    );
  return lock;
}

async function healthy(origin: string): Promise<boolean | 'starting'> {
  let response: Response;
  try {
    response = await fetch(`${origin}/api/health`, {
      signal: AbortSignal.timeout(1000),
      redirect: 'manual',
    });
  } catch (error) {
    if ((error as Error).name === 'TimeoutError') return 'starting';
    if ((error as { cause?: NodeJS.ErrnoException }).cause?.code === 'ECONNREFUSED') return false;
    throw new Error(
      `Cannot verify the server at ${origin}. Check the listener and restart Foggybrain; auto-start was not attempted.`,
    );
  }
  if (response.headers.get(HEALTH_HEADER) === HEALTH_PROTOCOL && response.status === 503) {
    await response.body?.cancel();
    return 'starting';
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if ((error as Error).name === 'TimeoutError') return 'starting';
    body = null;
  }
  if (
    response.ok &&
    response.headers.get(HEALTH_HEADER) === HEALTH_PROTOCOL &&
    body !== null &&
    typeof body === 'object' &&
    'ok' in body &&
    body.ok === true
  )
    return true;
  throw new Error(
    `The listener at ${origin} is not a compatible Foggybrain server. Restart older Foggybrain servers with this installation, or free the port. Auto-start was not attempted.`,
  );
}

/** Call only for the default local API; explicit CLI URL overrides must bypass this helper. */
export async function ensureLocalServer(origin?: string): Promise<string> {
  const env = await readUserEnvironment();
  origin ??= await resolveDefaultOrigin(env);
  const url = new URL(origin);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Auto-start supports only an http://127.0.0.1 local origin.');
  origin = url.origin;
  const logPath = join(homedir(), '.local', 'state', 'foggybrain', 'server.log');
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const health = await healthy(origin);
    if (health === true) return origin;
    if (health === 'starting') {
      await delay(100);
      continue;
    }
    const lock = await tryLock(`foggybrain:startup:${origin}`);
    if (!lock) {
      await delay(100);
      continue;
    }
    try {
      const health = await healthy(origin);
      if (health === true) return origin;
      if (health === 'starting') continue;
      const source = import.meta.url.endsWith('.ts');
      const entry = fileURLToPath(new URL(source ? './server.ts' : './server.js', import.meta.url));
      let failed = false;
      try {
        await mkdir(join(logPath, '..'), { recursive: true, mode: 0o700 });
        const log = await open(logPath, 'a', 0o600);
        try {
          const child = spawn(
            process.execPath,
            [...(source ? ['--import', import.meta.resolve('tsx')] : []), entry],
            {
              cwd: homedir(),
              env: { ...env, FOGGY_PORT: url.port || '80', FOGGY_MANAGED: '1' },
              detached: true,
              stdio: ['ignore', log.fd, log.fd],
            },
          );
          child.once('error', () => {
            failed = true;
          });
          child.once('exit', () => {
            failed = true;
          });
          child.unref();
        } finally {
          await log.close();
        }
      } catch {
        throw new Error(
          `Foggybrain could not start. Check permissions and the server log at ${logPath}.`,
        );
      }
      while (Date.now() < deadline) {
        if ((await healthy(origin)) === true) return origin;
        if (failed)
          throw new Error(
            `Foggybrain could not start. Check user configuration, the data-directory lock, and port; see ${logPath} for diagnostics.`,
          );
        await delay(100);
      }
      throw new Error(
        `Foggybrain startup timed out at ${origin}. Check ${logPath} before retrying; the server may still be starting.`,
      );
    } finally {
      lock.close();
    }
  }
  throw new Error(
    `Timed out waiting for Foggybrain at ${origin}. Check for an unresponsive listener, another startup, or a local lock-port collision; see ${logPath} for managed-server diagnostics.`,
  );
}
