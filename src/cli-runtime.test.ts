import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';

const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
const tsx = import.meta.resolve('tsx');

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'foggy-cli-runtime-'));
  const launches = join(home, 'launches');
  const pids = async () =>
    (await readFile(launches, 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(Number);
  t.after(async () => {
    for (const pid of await pids()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      for (let attempt = 0; ; attempt++) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') break;
          throw error;
        }
        assert.ok(attempt < 100, `Detached server ${pid} did not exit`);
        await delay(50);
      }
    }
    await rm(home, { recursive: true, force: true });
  });
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const origin = `http://127.0.0.1:${address.port}`;
  const configuration = join(home, '.config', 'foggybrain');
  const data = join(configuration, 'state');
  const bin = join(home, 'bin');
  const directories = [join(home, 'first'), join(home, 'second')];
  for (const directory of [configuration, bin, ...directories])
    await mkdir(directory, { recursive: true });
  await writeFile(
    join(configuration, '.env'),
    `FOGGY_PORT=${address.port}\nFOGGY_DATA_DIR=state\n`,
  );
  for (const directory of directories)
    await writeFile(join(directory, '.env'), 'FOGGY_PORT=1\nFOGGY_DATA_DIR=wrong\n');
  const preload = join(home, 'record-server.mjs');
  // Record even failed launches without replacing the real server or its database.
  await writeFile(
    preload,
    `import { appendFileSync } from 'node:fs';
if (process.env.FOGGY_MANAGED === '1') {
  appendFileSync(${JSON.stringify(launches)}, process.pid + '\\n');
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    appendFileSync(${JSON.stringify(join(home, 'server-errors'))}, chunk);
    return write(chunk, ...args);
  };
  setTimeout(() => process.exit(99), 60000).unref();
  const fetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname !== '127.0.0.1') throw new Error('External network forbidden in CLI runtime tests');
    return fetch(input, init);
  };
}
`,
  );
  const opened = join(home, 'opened');
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  await writeFile(
    join(bin, opener),
    `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(opened)}, JSON.stringify(process.argv.slice(2)) + '\\n');
console.log('opener stdout must not escape');
console.error('opener stderr must not escape');
`,
    { mode: 0o755 },
  );
  const run = (args: string[], cwd = directories[0], extra: NodeJS.ProcessEnv = {}) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', tsx, cli, ...args], {
        cwd,
        env: {
          HOME: home,
          PATH: bin,
          GH_TOKEN: '',
          GITHUB_TOKEN: '',
          NO_COLOR: '1',
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
          ...extra,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.once('error', reject);
      child.once('close', async (code) => {
        if (code !== 0) {
          const diagnostics = await readFile(join(home, 'server-errors'), 'utf8').catch(() => '');
          if (diagnostics) t.diagnostic(diagnostics);
        }
        resolve({ code, stdout, stderr });
      });
    });
  return { run, pids, origin, data, directories, opened, home };
}

test('stop is idempotent, never autostarts, and rejects explicit URL routing', async (t) => {
  const { run, pids } = await fixture(t);
  assert.deepEqual(await run(['--json', 'stop']), {
    code: 0,
    stdout: '{"stopped":[],"ignored":0}\n',
    stderr: '',
  });
  const human = await run(['stop']);
  assert.equal(human.code, 0);
  assert.equal(human.stderr, '');
  assert.match(human.stdout, /Stopped 0 Foggybrain/);
  for (const extra of [{}, { FOGGY_URL: 'https://example.com' }]) {
    const result = await run(
      ['--json', ...(extra.FOGGY_URL ? [] : ['--url', 'http://127.0.0.1:1']), 'stop'],
      undefined,
      extra,
    );
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(JSON.parse(result.stderr).error, /local-only/);
  }
  assert.deepEqual(await pids(), []);
});

test('stop shuts down multiple managed instances and a foreground API, releases locks, and preserves data', async (t) => {
  const { run, home, origin, data } = await fixture(t);
  assert.equal((await run(['--json', 'task', 'create', 'Preserved'])).code, 0);
  const origins = [origin];
  for (const managed of [true, false]) {
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const address = reservation.address();
    assert.ok(address && typeof address !== 'string');
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const extra = {
      FOGGY_PORT: String(address.port),
      FOGGY_DATA_DIR: join(home, `data-${managed}`),
    };
    origins.push(`http://127.0.0.1:${address.port}`);
    if (managed) assert.equal((await run(['--json', 'dashboard'], undefined, extra)).code, 0);
    else {
      const child = spawn(
        process.execPath,
        ['--import', tsx, fileURLToPath(new URL('./server.ts', import.meta.url))],
        {
          cwd: home,
          env: { HOME: home, PATH: '', ...extra },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGKILL');
          await exited;
        }
      });
      await once(child.stdout!, 'data');
    }
  }
  const result = await run(['--json', '--workspace', 'irrelevant', 'stop']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { stopped: origins.sort(), ignored: 0 });
  for (const target of origins) await assert.rejects(fetch(`${target}/api/health`));
  assert.deepEqual(JSON.parse((await run(['--json', 'stop'])).stdout), { stopped: [], ignored: 0 });
  assert.ok((await readdir(data)).length);
  const restarted = await run(['--json', 'task', 'list']);
  assert.equal(restarted.code, 0, restarted.stderr);
  assert.equal(JSON.parse(restarted.stdout)[0].title, 'Preserved');
  assert.equal((await run(['stop'])).code, 0);
});

test('control identity alone cannot authorize shutdown; private token is required', async (t) => {
  const { run, home, origin } = await fixture(t);
  assert.equal((await run(['--json', 'graph'])).code, 0);
  const directory = join(home, '.local', 'state', 'foggybrain', 'instances');
  const [name] = await readdir(directory);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600);
  const record = JSON.parse(await readFile(join(directory, name), 'utf8'));
  const socket = createConnection({ host: '127.0.0.1', port: record.port });
  t.after(() => socket.destroy());
  const [greeting] = await once(socket, 'data');
  assert.equal(greeting.toString(), `foggybrain-stop/1 ${record.identity}\n`);
  const closed = once(socket, 'close');
  socket.write(`stop ${record.identity}\n`);
  await closed;
  assert.equal((await fetch(`${origin}/api/health`)).status, 200);
  assert.equal((await run(['--json', 'stop'])).code, 0);
});

test('stop ignores stale and malformed records and unknown listeners without sending commands', async (t) => {
  const { run, home, pids } = await fixture(t);
  const directory = join(home, '.local', 'state', 'foggybrain', 'instances');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let received = '';
  const unknown = createServer((socket) => {
    socket.on('data', (chunk) => {
      received += chunk;
    });
    socket.end(`foggybrain-stop/1 ${randomUUID()}\n`);
  });
  unknown.listen(0, '127.0.0.1');
  await once(unknown, 'listening');
  t.after(() => new Promise<void>((resolve) => unknown.close(() => resolve())));
  const address = unknown.address();
  assert.ok(address && typeof address !== 'string');
  const stale = createServer();
  stale.listen(0, '127.0.0.1');
  await once(stale, 'listening');
  const staleAddress = stale.address();
  assert.ok(staleAddress && typeof staleAddress !== 'string');
  await new Promise<void>((resolve) => stale.close(() => resolve()));
  for (const port of [address.port, staleAddress.port]) {
    const identity = randomUUID();
    await writeFile(
      join(directory, `${identity}.json`),
      JSON.stringify({
        identity,
        token: randomUUID(),
        port,
        origin: 'http://127.0.0.1:4173',
        pid: process.pid,
      }),
      { mode: 0o600 },
    );
  }
  await writeFile(join(directory, 'bad.json'), '{', { mode: 0o600 });
  await symlink(join(directory, 'bad.json'), join(directory, 'link.json'));
  const result = await run(['--json', 'stop']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { stopped: [], ignored: 4 });
  assert.equal(received, '');
  assert.ok(unknown.listening);
  assert.deepEqual(await pids(), []);
});

test('unconfirmed shutdown fails with clean JSON output and retains its record', async (t) => {
  const { run, home } = await fixture(t);
  const directory = join(home, '.local', 'state', 'foggybrain', 'instances');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const identity = randomUUID();
  const token = randomUUID();
  const control = createServer((socket) => {
    socket.write(`foggybrain-stop/1 ${identity}\n`);
    socket.once('data', (chunk) => {
      assert.equal(chunk.toString(), `stop ${token}\n`);
      socket.end('failed\n');
    });
  });
  control.listen(0, '127.0.0.1');
  await once(control, 'listening');
  t.after(() => new Promise<void>((resolve) => control.close(() => resolve())));
  const address = control.address();
  assert.ok(address && typeof address !== 'string');
  const path = join(directory, `${identity}.json`);
  await writeFile(
    path,
    JSON.stringify({ identity, token, port: address.port, origin: 'http://127.0.0.1:4173' }),
    { mode: 0o600 },
  );
  const result = await run(['--json', 'stop']);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(JSON.parse(result.stderr).error, /Shutdown unconfirmed/);
  assert.ok(await stat(path));
});

test('CLI cold JSON startup shares real state across cwd and human output identifies the API', async (t) => {
  const { run, pids, origin, data, directories } = await fixture(t);
  const created = await run(['--json', 'task', 'create', 'Shared across directories']);
  assert.equal(created.code, 0, created.stderr);
  assert.equal(created.stderr, '');
  const task = JSON.parse(created.stdout);
  assert.equal(typeof task.id, 'string');
  const firstPids = await pids();
  assert.equal(firstPids.length, 1);
  const listed = await run(['--json', 'task', 'list'], directories[1]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(listed.stderr, '');
  assert.deepEqual(JSON.parse(listed.stdout), [task]);
  const human = await run(['task', 'list'], directories[1]);
  assert.equal(human.code, 0, human.stderr);
  assert.equal(human.stderr, `Running against local API at ${origin}\n`);
  assert.ok(human.stdout.includes(task.id));
  assert.ok(human.stdout.includes('Shared across directories'));
  assert.deepEqual(await pids(), firstPids);
  assert.ok((await readdir(data)).length > 0);
  for (const directory of directories) assert.deepEqual(await readdir(directory), ['.env']);
});

test('concurrent cold CLI commands reuse exactly one detached server', async (t) => {
  const { run, pids, directories } = await fixture(t);
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, (_, index) =>
      run(['--json', 'task', 'list'], directories[index % directories.length]),
    ),
  );
  for (const result of results) {
    if (result.status !== 'fulfilled') throw result.reason;
    assert.equal(result.value.code, 0, result.value.stderr);
    assert.equal(result.value.stderr, '');
    assert.deepEqual(JSON.parse(result.value.stdout), []);
  }
  const launched = await pids();
  assert.equal(launched.length, 1);
  process.kill(launched[0], 0);
  const again = await run(['--json', 'task', 'list']);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stderr, '');
  assert.deepEqual(JSON.parse(again.stdout), []);
  assert.deepEqual(await pids(), launched);
});

test('dashboard starts the API and repeated calls use the PATH opener without another server', async (t) => {
  const { run, pids, origin, directories, opened } = await fixture(t);
  const workspace = 'selected /?;$(not-a-command)';
  const url = new URL(origin);
  url.searchParams.set('workspace', workspace);
  for (const cwd of directories) {
    const result = await run(['--json', '--workspace', workspace, 'dashboard'], cwd);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { url: url.href, opened: true });
    assert.equal((await pids()).length, 1);
  }
  assert.deepEqual(
    (await readFile(opened, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
    [[url.href], [url.href]],
  );
});

test('help and explicit unreachable URLs never start a fallback server; ui remains opener-only', async (t) => {
  const { run, pids, origin, data } = await fixture(t);
  for (const args of [['--help'], ['dashboard', '--help'], ['task', 'list', '--help']]) {
    const result = await run(['--json', ...args]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /Usage:/);
  }
  for (const envOverride of [false, true]) {
    const result = await run(
      ['--json', ...(envOverride ? [] : ['--url', origin]), 'graph'],
      undefined,
      envOverride ? { FOGGY_URL: origin } : {},
    );
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    const error = JSON.parse(result.stderr);
    assert.deepEqual(Object.keys(error), ['error']);
    assert.match(error.error, /Cannot reach Foggybrain/);
    assert.ok(error.error.includes(origin));
  }
  const ui = await run(['--json', '--url', origin, 'ui']);
  assert.equal(ui.code, 0, ui.stderr);
  assert.equal(ui.stderr, '');
  assert.deepEqual(JSON.parse(ui.stdout), { url: `${origin}/`, opened: true });
  assert.deepEqual(await pids(), []);
  await assert.rejects(readdir(data), { code: 'ENOENT' });
  await assert.rejects(fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) }));
});
