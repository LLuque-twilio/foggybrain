import assert from 'node:assert/strict';
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

test('dataDirectory, pidFilePath, and serverOrigin follow the server environment', () => {
  assert.equal(dataDirectory({ FOGGY_DATA_DIR: '/tmp/foggy-data' }), '/tmp/foggy-data');
  assert.equal(pidFilePath({ FOGGY_DATA_DIR: '/tmp/foggy-data' }), '/tmp/foggy-data/foggy.pid');
  assert.match(dataDirectory({}), /\.local\/share\/foggybrain$/);
  assert.equal(serverOrigin({}), 'http://127.0.0.1:4173');
  assert.equal(serverOrigin({ FOGGY_PORT: '4189' }), 'http://127.0.0.1:4189');
  assert.throws(() => dataDirectory({ FOGGY_DATA_DIR: ' ' }), /must not be empty/);
  assert.throws(() => serverOrigin({ FOGGY_PORT: '0' }), /FOGGY_PORT/);
});

test('startServer writes a pidfile, unrefs the child, and refuses a second server', async () => {
  const dir = await scratch();
  const env = { FOGGY_DATA_DIR: dir, FOGGY_PORT: '4321' };
  let unrefs = 0;
  const spawnImpl = ((command: string, args: string[], options: Record<string, unknown>) => {
    assert.equal(command, process.execPath);
    assert.ok(args.at(-1)?.includes('server'));
    assert.equal(options.detached, true);
    assert.equal(options.stdio, 'ignore');
    return {
      pid: process.pid,
      unref: () => {
        unrefs++;
      },
    };
  }) as never;
  const started = await startServer({ env, spawnImpl });
  assert.equal(started.pid, process.pid);
  assert.equal(started.url, 'http://127.0.0.1:4321');
  assert.equal(unrefs, 1);
  assert.equal((await readFile(join(dir, 'foggy.pid'), 'utf8')).trim(), String(process.pid));
  assert.equal(await readRunningPid(env), process.pid);
  await assert.rejects(() => startServer({ env, spawnImpl }), /already running/);
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
