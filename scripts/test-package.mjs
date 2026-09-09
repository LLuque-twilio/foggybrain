import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
assert.ok(process.argv.length <= 3, 'Usage: pnpm test:package [archive.tgz]');
const checkout = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'foggy-package-'));
const home = join(temporary, 'home');
const prefix = join(temporary, 'prefix');
const bin = join(temporary, 'bin');
const cwd = join(temporary, 'outside-checkout');
const launches = join(temporary, 'launches');
const violations = join(temporary, 'network-violations');
const executable = join(prefix, 'bin', 'foggy');
let runtimeStarted = false;
let env;
let port;

async function run(command, args, options = {}) {
  try {
    return await execute(command, args, {
      cwd,
      env,
      timeout: 30000,
      maxBuffer: 16 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    throw new Error(
      `${command} ${args.join(' ')} failed:\n${error.stdout ?? ''}${error.stderr ?? ''}`,
      {
        cause: error,
      },
    );
  }
}

async function json(args) {
  const result = await run(executable, ['--json', ...args]);
  assert.equal(result.stderr, '', `Unexpected stderr: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function stopped() {
  const pids = (
    await readFile(launches, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    })
  )
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(Number);
  for (let attempt = 0; attempt < 100; attempt++) {
    const alive = pids.some((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === 'ESRCH') return false;
        throw error;
      }
    });
    if (!alive) break;
    assert.ok(attempt < 99, `Managed servers still running: ${pids.join(', ')}`);
    await delay(50);
  }
  const listening = await new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (error) => {
      if (error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(new Error('Port probe timed out'));
    });
  });
  assert.equal(listening, false, `Server still listening on ${port}`);
}

try {
  for (const directory of [home, prefix, bin, cwd, join(home, '.config', 'gh')]) {
    await mkdir(directory, { recursive: true });
  }
  const userconfig = join(temporary, 'npmrc');
  const globalconfig = join(temporary, 'global-npmrc');
  await writeFile(userconfig, '');
  await writeFile(globalconfig, '');
  env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    GH_CONFIG_DIR: join(home, '.config', 'gh'),
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
    GH_ENTERPRISE_TOKEN: '',
    GITHUB_ENTERPRISE_TOKEN: '',
    FOGGY_SYNC_TOKEN: '',
    PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(
      delimiter,
    ),
    TMPDIR: temporary,
    NO_COLOR: '1',
    npm_config_cache: join(temporary, 'npm-cache'),
    npm_config_userconfig: userconfig,
    npm_config_globalconfig: globalconfig,
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_fetch_retries: '0',
    npm_config_fetch_timeout: '15000',
  };
  // An empty gh configuration alone does not rule out OS credential-store access.
  await writeFile(join(bin, 'gh'), '#!/usr/bin/env node\nprocess.exit(1);\n', { mode: 0o755 });

  let archive = process.argv[2] && resolve(process.argv[2]);
  if (!archive) {
    const packed = await run('pnpm', ['pack', '--pack-destination', temporary], {
      cwd: checkout,
      env: { ...env, PATH: process.env.PATH },
      timeout: 180000,
    });
    process.stdout.write(packed.stdout);
    const archives = (await readdir(temporary)).filter((name) => name.endsWith('.tgz'));
    assert.equal(archives.length, 1, 'Expected exactly one packed archive');
    archive = join(temporary, archives[0]);
  }
  console.log(`Testing archive: ${archive}`);
  const entries = (await run('tar', ['-tzf', archive])).stdout.trim().split('\n');
  const verbose = (await run('tar', ['-tvzf', archive])).stdout.trim().split('\n');
  assert.equal(new Set(entries).size, entries.length, 'Duplicate tar entries');
  assert.ok(
    verbose.every((line) => line.startsWith('-') || line.startsWith('d')),
    'Only regular files/directories allowed',
  );
  const required = [
    'package.json',
    'bin/foggy.mjs',
    'dist/server/cli.js',
    'dist/server/server.js',
    'dist/web/index.html',
    'dist/web/favicon.svg',
    'README.md',
    'LICENSE',
    'CONTRACT.md',
    'openapi.json',
  ];
  for (const name of entries) {
    assert.ok(name.startsWith('package/'), `Unexpected tar path: ${name}`);
    const path = name.slice('package/'.length);
    assert.ok(
      !path.split('/').some((part) => part === '..' || part.startsWith('.')),
      `Unsafe/hidden path: ${name}`,
    );
    assert.ok(
      !/(^|\/)(?:src|node_modules|tests?|__tests__|secrets?)(\/|$)|\.(?:test|spec)\.|\.(?:pem|key|sqlite\w*|db|log)$|(?:^|\/)\.env/i.test(
        path,
      ),
      `Forbidden entry: ${name}`,
    );
    assert.ok(
      required.includes(path) ||
        /^(?:bin|dist|dist\/server|dist\/web|dist\/web\/assets|docs)\/$/.test(path) ||
        /^dist\/server\/[\w-]+\.js$/.test(path) ||
        /^dist\/web\/assets\/[\w.-]+\.(?:js|css|woff2?)$/.test(path) ||
        /^docs\/[\w/-]+\.md$/.test(path),
      `Entry outside release allowlist: ${name}`,
    );
  }
  for (const path of required) assert.ok(entries.includes(`package/${path}`), `Missing ${path}`);
  for (const extension of ['js', 'css', 'woff2']) {
    assert.ok(
      entries.some(
        (name) => name.startsWith('package/dist/web/assets/') && name.endsWith(`.${extension}`),
      ),
      `Missing web ${extension} assets`,
    );
  }
  const metadata = JSON.parse(
    (await run('tar', ['-xOzf', archive, 'package/package.json'])).stdout,
  );
  assert.equal(metadata.name, 'foggybrain');
  assert.match(metadata.version, /^\d+\.\d+\.\d+(?:[-+].+)?$/);
  assert.equal(metadata.private, true);
  assert.equal(metadata.type, 'module');
  assert.equal(metadata.license, 'MIT');
  assert.equal(metadata.bin?.foggy, './bin/foggy.mjs');
  assert.equal(metadata.engines?.node, '>=22.13.0');

  await run(
    'npm',
    [
      'install',
      '--global',
      '--prefix',
      prefix,
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      archive,
    ],
    { timeout: 180000 },
  );
  const installed = join(prefix, 'lib', 'node_modules', 'foggybrain');
  assert.deepEqual(JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')), metadata);
  const dependencyEntries = await readdir(join(installed, 'node_modules'), { recursive: true });
  // Type packages may legitimately be production peers; tsx must never be needed.
  assert.ok(
    !dependencyEntries.some((path) => path === 'tsx' || path.endsWith('/node_modules/tsx')),
    'tsx must not be installed',
  );

  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  port = reservation.address().port;
  await new Promise((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const origin = `http://127.0.0.1:${port}`;
  const preload = join(temporary, 'guard.mjs');
  await writeFile(
    preload,
    `import { appendFileSync } from 'node:fs';
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== ${JSON.stringify(origin)}) {
    appendFileSync(${JSON.stringify(violations)}, url.origin + '\\n');
    throw new Error('External network forbidden in package tests');
  }
  return originalFetch(input, { ...init, redirect: 'error' });
};
if (process.env.FOGGY_MANAGED === '1') {
  appendFileSync(${JSON.stringify(launches)}, process.pid + '\\n');
  setTimeout(() => process.exit(99), 60000).unref();
}
`,
  );
  env = {
    ...env,
    FOGGY_PORT: String(port),
    FOGGY_DATA_DIR: join(home, 'data'),
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
  };
  runtimeStarted = true;
  assert.match((await run(executable, ['--help'])).stdout, /Usage:.*foggy/);
  const workspaces = await json(['workspace', 'list']);
  assert.equal(workspaces.workspaces.length, 1);
  assert.equal(workspaces.workspaces[0].id, workspaces.defaultWorkspaceId);
  const graph = await json(['graph']);
  for (const key of ['tasks', 'dependencies', 'references', 'layouts'])
    assert.deepEqual(graph[key], []);
  const task = await json(['task', 'create', 'Package persistence smoke test', '--kind', 'manual']);
  assert.equal(typeof task.id, 'string');

  async function served(path, contentType) {
    const url = new URL(path, origin);
    assert.equal(url.origin, origin, `External UI asset: ${path}`);
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, `Not served: ${path}`);
    assert.match(response.headers.get('content-type') ?? '', contentType);
    const body = await response.text();
    assert.ok(body.length > 0, `Empty response: ${path}`);
    return body;
  }
  const html = await served('/', /text\/html/);
  assert.match(html, /<div id="root"><\/div>/);
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((match) => match[1]);
  for (const extension of ['js', 'css'])
    assert.ok(
      assets.some((path) => path.endsWith(`.${extension}`)),
      `HTML missing ${extension}`,
    );
  for (const asset of assets) {
    assert.ok(
      entries.includes(`package/dist/web${new URL(asset, origin).pathname}`),
      `Asset absent from archive: ${asset}`,
    );
    await served(asset, asset.endsWith('.css') ? /text\/css/ : /(?:text|application)\/javascript/);
  }
  assert.deepEqual(await json(['stop']), { stopped: [origin], ignored: 0 });
  await stopped();
  assert.ok(
    (await json(['graph'])).tasks.some((item) => item.id === task.id && item.title === task.title),
  );
  assert.equal(
    await readFile(violations, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    }),
    '',
    'Runtime attempted external network access',
  );
} catch (error) {
  if (runtimeStarted) {
    const log = await readFile(
      join(home, '.local', 'state', 'foggybrain', 'server.log'),
      'utf8',
    ).catch(() => '');
    if (log) console.error(`Isolated package-test server log:\n${log}`);
  }
  throw error;
} finally {
  let safeToRemove = !runtimeStarted;
  try {
    if (runtimeStarted) {
      const result = await json(['stop']);
      assert.equal(result.ignored, 0, 'Shutdown left unrecognized runtime records');
      await stopped();
      safeToRemove = true;
    }
  } finally {
    if (safeToRemove) await rm(temporary, { recursive: true, force: true });
    else
      console.error(
        `Shutdown unconfirmed; preserving temporary installation and diagnostics: ${temporary}`,
      );
  }
}
console.log(
  'Package smoke test passed: archive, production install, CLI, UI assets, restart persistence, and shutdown.',
);
