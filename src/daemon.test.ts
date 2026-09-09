import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  dataDirectory,
  pidFilePath,
  readRunningPid,
  serverOrigin,
  startServer,
  stopServer,
} from './daemon.js';

const scratch = () => mkdtemp(join(tmpdir(), 'foggy-daemon-'));

// startServer unrefs the child, so an exit listener alone no longer holds the event loop open and
// the runner can drain before the kill is observed. A ref'd timer keeps it alive until exit lands.
function exitOf(child: ChildProcess): Promise<void> {
  return new Promise((done) => {
    const keepAlive = setInterval(() => {}, 50);
    child.once('exit', () => {
      clearInterval(keepAlive);
      done();
    });
  });
}

test('dataDirectory, pidFilePath, and serverOrigin follow the server environment', () => {
  assert.equal(dataDirectory({ FOGGY_DATA_DIR: '/tmp/foggy-data' }), '/tmp/foggy-data');
  assert.equal(pidFilePath({ FOGGY_DATA_DIR: '/tmp/foggy-data' }), '/tmp/foggy-data/foggy.pid');
  assert.match(dataDirectory({}), /\.local\/share\/foggybrain$/);
  assert.equal(serverOrigin({}), 'http://127.0.0.1:4173');
  assert.equal(serverOrigin({ FOGGY_PORT: '4189' }), 'http://127.0.0.1:4189');
  assert.throws(() => dataDirectory({ FOGGY_DATA_DIR: ' ' }), /must not be empty/);
  assert.throws(() => serverOrigin({ FOGGY_PORT: '0' }), /FOGGY_PORT/);
});

interface FakeChild {
  pid: number | undefined;
  unref: () => void;
  once: (event: string, listener: (code: number | null, signal: string | null) => void) => void;
}

function fakeSpawn(child: Partial<FakeChild>) {
  const stdio: unknown[] = [];
  const made: FakeChild = {
    pid: process.pid,
    unref: () => {},
    once: () => {},
    ...child,
  };
  const spawnImpl = ((command: string, args: string[], options: Record<string, unknown>) => {
    assert.equal(command, process.execPath);
    assert.ok(args.at(-1)?.includes('server'));
    assert.equal(options.detached, true);
    stdio.push(options.stdio);
    return made;
  }) as never;
  return { spawnImpl, stdio };
}

test('startServer writes a pidfile, unrefs the child, and refuses a second server', async () => {
  const dir = await scratch();
  const env = { FOGGY_DATA_DIR: dir, FOGGY_PORT: '4321' };
  let unrefs = 0;
  const { spawnImpl, stdio } = fakeSpawn({
    unref: () => {
      unrefs++;
    },
  });
  const probe = async () => ({ pid: process.pid });
  const started = await startServer({ env, spawnImpl, probe });
  assert.equal(started.pid, process.pid);
  assert.equal(started.url, 'http://127.0.0.1:4321');
  assert.equal(unrefs, 1);
  // Server output goes to a real log file, never to an inherited or discarded stream.
  const [stdin, out, err] = stdio[0] as [string, number, number];
  assert.equal(stdin, 'ignore');
  assert.equal(typeof out, 'number');
  assert.equal(out, err);
  assert.equal((await readFile(join(dir, 'foggy.pid'), 'utf8')).trim(), String(process.pid));
  assert.equal(await readRunningPid(env), process.pid);
  await assert.rejects(() => startServer({ env, spawnImpl, probe }), /already running/);
});

test('startServer fails without a pidfile when the server never answers', async () => {
  const dir = await scratch();
  const env = { FOGGY_DATA_DIR: dir, FOGGY_PORT: '4322' };
  // A real child, so the kill this asserts on is the real one and never a stray signal.
  const hung = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const exited = exitOf(hung);
  const spawnImpl = ((_command: string, _args: string[], options: Record<string, unknown>) => {
    writeFileSync(join(dir, 'foggy.log'), 'Error: listen EADDRINUSE 127.0.0.1:4322\n');
    assert.equal(options.detached, true);
    return hung;
  }) as never;
  await assert.rejects(
    () => startServer({ env, spawnImpl, probe: async () => null, readyTimeoutMs: 0 }),
    (error: Error) => {
      assert.match(error.message, /did not start on http:\/\/127\.0\.0\.1:4322/);
      assert.match(error.message, /never answered/);
      assert.match(error.message, /EADDRINUSE/);
      return true;
    },
  );
  await exited;
  assert.equal(await readRunningPid(env), null);
  await assert.rejects(() => readFile(join(dir, 'foggy.pid'), 'utf8'), /ENOENT/);
});

function realChild(script: string) {
  // A real child, so the SIGKILL the failure path sends lands on a process that is safe to kill.
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  return { child, exited: exitOf(child), spawnImpl: (() => child) as never };
}

test('startServer refuses a port that another process is already serving', async () => {
  const dir = await scratch();
  const env = { FOGGY_DATA_DIR: dir, FOGGY_PORT: '4323' };
  // The real shape of a port collision: something already answers, and the child that cannot bind
  // dies a moment later rather than before the first probe.
  const { spawnImpl, exited } = realChild('setTimeout(() => process.exit(1), 300)');
  await assert.rejects(
    () => startServer({ env, spawnImpl, probe: async () => ({ pid: process.pid }) }),
    new RegExp(`did not start .* already served by process ${process.pid}`, 's'),
  );
  await exited;
  assert.equal(await readRunningPid(env), null);
  await assert.rejects(() => readFile(join(dir, 'foggy.pid'), 'utf8'), /ENOENT/);
});

test('startServer refuses a health answer that does not name a process', async () => {
  const dir = await scratch();
  const env = { FOGGY_DATA_DIR: dir, FOGGY_PORT: '4324' };
  const { spawnImpl } = realChild('setTimeout(() => {}, 60000)');
  await assert.rejects(
    () => startServer({ env, spawnImpl, probe: async () => ({ pid: null }) }),
    /already served by another process/,
  );
  assert.equal(await readRunningPid(env), null);
});

test('startServer reports the exit status when the server dies with nothing answering', async () => {
  const dir = await scratch();
  const env = { FOGGY_DATA_DIR: dir, FOGGY_PORT: '4325' };
  const { spawnImpl } = realChild('setTimeout(() => process.exit(1), 50)');
  await assert.rejects(
    () => startServer({ env, spawnImpl, probe: async () => null }),
    /did not start .*it stopped \(exit code 1\)/s,
  );
  assert.equal(await readRunningPid(env), null);
});

test('a stale or malformed pidfile does not block a start and reports a clean stop', async () => {
  const dir = await scratch();
  const env = { FOGGY_DATA_DIR: dir };
  await writeFile(join(dir, 'foggy.pid'), 'not-a-pid\n');
  assert.equal(await readRunningPid(env), null);
  assert.deepEqual(await stopServer({ env }), { stopped: false, pid: null });
  assert.equal(await readRunningPid(env), null);
});

test('a started server answers the API and stops on request', async () => {
  const dir = await scratch();
  const env = {
    ...process.env,
    FOGGY_DATA_DIR: dir,
    FOGGY_PORT: '4356',
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
  };
  const started = await startServer({ env });
  try {
    let snapshot: Response | undefined;
    for (let attempt = 0; attempt < 100 && !snapshot?.ok; attempt++) {
      snapshot = await fetch(`${started.url}/api/state`).catch(() => undefined);
      if (!snapshot?.ok) await new Promise((done) => setTimeout(done, 100));
    }
    assert.equal(snapshot?.ok, true);
  } finally {
    assert.deepEqual(await stopServer({ env }), { stopped: true, pid: started.pid });
  }
  assert.equal(await readRunningPid(env), null);
});
