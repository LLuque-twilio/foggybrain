import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import {
  ensureLocalServer,
  HEALTH_HEADER,
  HEALTH_PROTOCOL,
  lockDataDirectory,
  readUserEnvironment,
} from './runtime.js';

const execute = promisify(execFile);
const runtimeUrl = new URL('./runtime.ts', import.meta.url).href;
const serverUrl = new URL('./server.ts', import.meta.url).href;
const tsx = import.meta.resolve('tsx');

async function temporary(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'foggy-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function listener(t: TestContext, header?: string, status = 200) {
  const server = createServer((_req, res) => {
    if (header) res.setHeader(HEALTH_HEADER, header);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, port: address.port, origin: `http://127.0.0.1:${address.port}` };
}

test('user configuration is cwd independent and process values take precedence', async (t) => {
  const home = await temporary(t);
  const directory = join(home, '.config', 'foggybrain');
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, '.env'),
    'FOGGY_PORT=4321\nFOGGY_DATA_DIR=state\nGH_TOKEN=fixture\n',
  );
  const env = await readUserEnvironment({ FOGGY_PORT: '5432', GH_TOKEN: '' }, home);
  assert.equal(env.FOGGY_PORT, '5432');
  assert.equal(env.GH_TOKEN, '');
  assert.equal(env.FOGGY_DATA_DIR, join(directory, 'state'));
  assert.deepEqual(await readUserEnvironment({}, join(home, 'missing')), {});
});

test('only compatible health is reused; legacy and incompatible listeners require restart', async (t) => {
  const compatible = await listener(t, HEALTH_PROTOCOL);
  assert.equal(await ensureLocalServer(compatible.origin), compatible.origin);
  for (const header of [undefined, '999']) {
    const incompatible = await listener(t, header);
    await assert.rejects(ensureLocalServer(incompatible.origin), /Restart older Foggybrain/);
  }
  const redirect = await listener(t, HEALTH_PROTOCOL, 302);
  await assert.rejects(ensureLocalServer(redirect.origin), /not a compatible/);
  await assert.rejects(ensureLocalServer('https://example.com'), /only an http/);
});

test('data-directory locks cover path aliases and recover after a killed process', async (t) => {
  const directory = await temporary(t);
  const data = join(directory, 'data');
  const child = spawn(
    process.execPath,
    [
      '--import',
      tsx,
      '--input-type=module',
      '-e',
      `import { lockDataDirectory } from ${JSON.stringify(runtimeUrl)}; await lockDataDirectory(${JSON.stringify(data)}); console.log('locked');`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  t.after(() => {
    child.kill('SIGKILL');
  });
  await once(child.stdout!, 'data');
  assert.equal((await stat(data)).mode & 0o777, 0o700);
  const alias = join(directory, 'alias');
  await symlink(data, alias);
  await assert.rejects(lockDataDirectory(alias), /already locked/);
  const exit = once(child, 'exit');
  child.kill('SIGKILL');
  await exit;
  const lock = await lockDataDirectory(alias);
  await new Promise<void>((resolve) => lock.close(() => resolve()));
});

test('timed-out health headers and bodies are retried without launching a server', async (t) => {
  for (const flushHeaders of [false, true]) {
    const home = await temporary(t);
    const endpoint = await listener(t);
    let probes = 0;
    endpoint.server.removeAllListeners('request');
    endpoint.server.on('request', (_req, res) => {
      probes++;
      res.setHeader(HEALTH_HEADER, HEALTH_PROTOCOL);
      if (flushHeaders) res.flushHeaders();
      if (probes === 1) {
        const timer = setTimeout(() => res.end('{"ok":true}'), 1500);
        res.on('close', () => clearTimeout(timer));
      } else res.end('{"ok":true}');
    });
    const result = await execute(
      process.execPath,
      [
        '--import',
        tsx,
        '--input-type=module',
        '-e',
        `import { ensureLocalServer } from ${JSON.stringify(runtimeUrl)}; console.log(await ensureLocalServer(${JSON.stringify(endpoint.origin)}));`,
      ],
      { env: { HOME: home, PATH: '' }, timeout: 25000 },
    );
    assert.equal(result.stdout.trim(), endpoint.origin);
    assert.equal(result.stderr, '');
    assert.ok(probes >= 2);
    await assert.rejects(stat(join(home, '.local')), { code: 'ENOENT' });
  }
});

test('an unresponsive listener times out without launching a server', async (t) => {
  const home = await temporary(t);
  const endpoint = await listener(t);
  endpoint.server.removeAllListeners('request');
  endpoint.server.on('request', () => {});
  const result = await execute(
    process.execPath,
    [
      '--import',
      tsx,
      '--input-type=module',
      '-e',
      `import { ensureLocalServer } from ${JSON.stringify(runtimeUrl)}; try { await ensureLocalServer(${JSON.stringify(endpoint.origin)}); process.exitCode = 2; } catch (error) { console.log(error.message); }`,
    ],
    { env: { HOME: home, PATH: '' }, timeout: 25000 },
  );
  assert.match(result.stdout, /Timed out waiting.*unresponsive listener/);
  assert.equal(result.stderr, '');
  await assert.rejects(stat(join(home, '.local')), { code: 'ENOENT' });
});

test('failed managed starts append diagnostics to a private log without exposing configuration', async (t) => {
  const home = await temporary(t);
  const endpoint = await listener(t);
  await new Promise<void>((resolve) => endpoint.server.close(() => resolve()));
  const preload = join(home, 'failed-server.mjs');
  await writeFile(
    preload,
    `
    if (process.env.FOGGY_MANAGED === '1') {
      console.error('fixture startup failure');
      process.exit(1);
    }
  `,
  );
  const logPath = join(home, '.local', 'state', 'foggybrain', 'server.log');
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await execute(
      process.execPath,
      [
        '--import',
        tsx,
        '--input-type=module',
        '-e',
        `import { ensureLocalServer } from ${JSON.stringify(runtimeUrl)}; try { await ensureLocalServer(${JSON.stringify(endpoint.origin)}); process.exitCode = 2; } catch (error) { console.error(error.message); }`,
      ],
      {
        env: {
          HOME: home,
          PATH: '',
          GH_TOKEN: 'secret-fixture',
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        },
        timeout: 25000,
      },
    );
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Foggybrain could not start/);
    assert.ok(result.stderr.includes(logPath));
    assert.ok(!result.stderr.includes('secret-fixture'));
  }
  assert.equal(await readFile(logPath, 'utf8'), 'fixture startup failure\n'.repeat(2));
  assert.equal((await stat(logPath)).mode & 0o777, 0o600);
});

test('server reserves its API port and directory lock before opening databases', async (t) => {
  const home = await temporary(t);
  const occupied = await listener(t);
  const data = join(home, 'data');
  await mkdir(data);
  const env = { HOME: home, PATH: '', FOGGY_DATA_DIR: data, FOGGY_PORT: String(occupied.port) };
  const code = `import { startServer } from ${JSON.stringify(serverUrl)}; try { await startServer({loadEnv:false}); process.exitCode=2; } catch { console.log('blocked'); }`;
  const blockedPort = await execute(
    process.execPath,
    ['--import', tsx, '--input-type=module', '-e', code],
    { env },
  );
  assert.equal(blockedPort.stdout.trim(), 'blocked');
  assert.deepEqual(await readdir(data), []);
  await new Promise<void>((resolve) => occupied.server.close(() => resolve()));
  const lock = await lockDataDirectory(data);
  try {
    const blockedDirectory = await execute(
      process.execPath,
      ['--import', tsx, '--input-type=module', '-e', code],
      { env },
    );
    assert.equal(blockedDirectory.stdout.trim(), 'blocked');
    assert.deepEqual(await readdir(data), []);
  } finally {
    await new Promise<void>((resolve) => lock.close(() => resolve()));
  }
});

test('concurrent CLI processes launch one detached server from user config, without cwd dotenv', async (t) => {
  const home = await temporary(t);
  const reserved = await listener(t);
  await new Promise<void>((resolve) => reserved.server.close(() => resolve()));
  const configuration = join(home, '.config', 'foggybrain');
  await mkdir(configuration, { recursive: true });
  await writeFile(
    join(configuration, '.env'),
    `FOGGY_PORT=${reserved.port}\nFOGGY_DATA_DIR=state\n`,
  );
  const cwd = join(home, 'elsewhere');
  await mkdir(cwd);
  await writeFile(join(cwd, '.env'), 'FOGGY_PORT=1\n');
  const launches = join(home, 'launches');
  const preload = join(home, 'fake-server.mjs');
  // Hold module evaluation in a health-only server: no SQLite or GitHub is used.
  await writeFile(
    preload,
    `
    import { createServer } from 'node:http';
    import { appendFileSync, realpathSync } from 'node:fs';
    if (process.env.FOGGY_MANAGED === '1') {
      appendFileSync(${JSON.stringify(launches)}, process.pid + '\\n');
      console.log('managed stdout');
      console.error('managed stderr');
      if (process.cwd() !== realpathSync(${JSON.stringify(home)})) process.exit(3);
      if (process.env.FOGGY_DATA_DIR !== ${JSON.stringify(join(configuration, 'state'))}) process.exit(4);
      await new Promise(resolve => setTimeout(resolve, 400));
      createServer((req, res) => {
        res.setHeader(${JSON.stringify(HEALTH_HEADER)}, ${JSON.stringify(HEALTH_PROTOCOL)});
        res.end('{"ok":true}');
      }).listen(Number(process.env.FOGGY_PORT), '127.0.0.1');
      await new Promise(() => {});
    }
  `,
  );
  t.after(async () => {
    const pids = await readFile(launches, 'utf8').catch(() => '');
    for (const pid of pids.trim().split('\n').filter(Boolean)) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        /* Already exited. */
      }
    }
  });
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () =>
      execute(
        process.execPath,
        [
          '--import',
          tsx,
          '--input-type=module',
          '-e',
          `import { ensureLocalServer } from ${JSON.stringify(runtimeUrl)}; console.log(await ensureLocalServer());`,
        ],
        {
          cwd,
          env: { HOME: home, PATH: '', NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
          timeout: 25000,
        },
      ),
    ),
  );
  for (const result of results) {
    assert.equal(
      result.status,
      'fulfilled',
      result.status === 'rejected' ? String(result.reason) : '',
    );
    if (result.status === 'fulfilled') {
      assert.equal(result.value.stdout.trim(), reserved.origin);
      assert.equal(result.value.stderr, '');
    }
  }
  assert.equal((await readFile(launches, 'utf8')).trim().split('\n').length, 1);
  const logDirectory = join(home, '.local', 'state', 'foggybrain');
  const logPath = join(logDirectory, 'server.log');
  assert.equal((await stat(logDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(logPath)).mode & 0o777, 0o600);
  assert.equal(await readFile(logPath, 'utf8'), 'managed stdout\nmanaged stderr\n');
});
