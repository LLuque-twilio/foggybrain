import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  assertVersion,
  checksumFor,
  binDirectory,
  currentVersion,
  downloadVersion,
  ensurePathEntry,
  execute,
  installRoot,
  linkVersion,
  packageVersion,
  releaseAssetUrl,
  releaseChecksumUrl,
  removePathEntry,
  resolveLatestVersion,
  uninstall,
  upgrade,
  versionDirectory,
} from './install.js';

test('packageVersion reads the version from package.json', () => {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version: string };
  assert.equal(packageVersion(), manifest.version);
  assert.match(packageVersion(), /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
});

const scratch = () => mkdtemp(join(tmpdir(), 'foggy-install-'));

async function installed(root: string, version: string) {
  const directory = versionDirectory(version, root);
  await mkdir(join(directory, 'bin'), { recursive: true });
  await mkdir(join(directory, 'dist', 'server'), { recursive: true });
  await writeFile(join(directory, 'bin', 'foggy.mjs'), '#!/usr/bin/env node\n', { mode: 0o755 });
  await writeFile(join(directory, 'dist', 'server', 'cli.js'), '');
  return directory;
}

test('assertVersion normalizes tags and rejects anything that could escape the version directory', () => {
  assert.equal(assertVersion('v1.2.3'), '1.2.3');
  assert.equal(assertVersion('1.2.3-rc.1'), '1.2.3-rc.1');
  for (const bad of ['', 'latest', '../etc', '1.2', '1.2.3/../x', 'v1.2.3 ', 'v v1.2.3'])
    assert.throws(() => assertVersion(bad), /version/i, bad);
});

test('installRoot, versionDirectory, and binDirectory honor FOGGY_HOME and the home directory', () => {
  assert.equal(installRoot({ FOGGY_HOME: '/tmp/fh' }, '/home/x'), '/tmp/fh');
  assert.equal(installRoot({}, '/home/x'), '/home/x/.foggybrain');
  assert.equal(versionDirectory('1.2.3', '/tmp/fh'), '/tmp/fh/versions/1.2.3');
  assert.equal(binDirectory('/home/x'), '/home/x/.local/bin');
});

test('linkVersion flips current, links the executable, and is idempotent', async () => {
  const root = await scratch();
  const home = await scratch();
  const binDir = join(home, '.local', 'bin');
  await installed(root, '0.1.0');
  await installed(root, '0.2.0');
  const calls: string[][] = [];
  const run = async (file: string, args: string[]) => {
    calls.push([file, ...args]);
  };
  const first = await linkVersion({ version: '0.1.0', root, binDir, home, platform: 'linux', run });
  assert.equal(first.version, '0.1.0');
  assert.equal(first.path, versionDirectory('0.1.0', root));
  assert.equal(first.bin, join(binDir, 'foggy'));
  assert.equal(first.pathEntry, 'created');
  assert.equal(await currentVersion(root), '0.1.0');
  assert.equal(await readlink(join(binDir, 'foggy')), join(root, 'current', 'bin', 'foggy.mjs'));

  const second = await linkVersion({
    version: 'v0.2.0',
    root,
    binDir,
    home,
    platform: 'linux',
    run,
  });
  assert.equal(second.version, '0.2.0');
  assert.equal(second.pathEntry, 'present');
  assert.equal(await currentVersion(root), '0.2.0');
  const profile = await readFile(join(home, '.profile'), 'utf8');
  assert.equal(profile.match(/# foggybrain/g)?.length, 1);
  assert.ok(profile.includes(`export PATH="${binDir}:$PATH" # foggybrain`));
  assert.deepEqual(calls, []);
});

test('linkVersion rejects a version that is not installed', async () => {
  const root = await scratch();
  await assert.rejects(
    () =>
      linkVersion({
        version: '9.9.9',
        root,
        binDir: join(root, 'bin'),
        home: root,
        platform: 'linux',
        run: async () => {},
      }),
    /not installed/,
  );
});

test('linkVersion refuses a foggy executable from another installation unless forced', async () => {
  const root = await scratch();
  const home = await scratch();
  const other = await scratch();
  const binDir = join(home, '.local', 'bin');
  await installed(root, '0.1.0');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(other, 'foggy.mjs'), '#!/usr/bin/env node\n');
  await symlink(join(other, 'foggy.mjs'), join(binDir, 'foggy'));
  const link = (force?: boolean) =>
    linkVersion({
      version: '0.1.0',
      root,
      binDir,
      home,
      platform: 'linux',
      run: async () => {},
      force,
    });
  await assert.rejects(link(), new RegExp(`belongs to another FoggyBrain installation.*${other}`));
  assert.equal(await readlink(join(binDir, 'foggy')), join(other, 'foggy.mjs'));
  assert.equal(await currentVersion(root), null);

  assert.equal((await link(true)).version, '0.1.0');
  assert.equal(await readlink(join(binDir, 'foggy')), join(root, 'current', 'bin', 'foggy.mjs'));
});

test('linkVersion treats a regular-file foggy shim as another installation', async () => {
  const root = await scratch();
  const home = await scratch();
  const binDir = join(home, '.local', 'bin');
  await installed(root, '0.1.0');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'foggy'), '#!/bin/sh\nexec other-foggy "$@"\n', { mode: 0o755 });
  await assert.rejects(
    () =>
      linkVersion({
        version: '0.1.0',
        root,
        binDir,
        home,
        platform: 'linux',
        run: async () => {},
      }),
    /belongs to another FoggyBrain installation/,
  );
});

test('linkVersion reports a failed PATH entry instead of failing an install that worked', async () => {
  const root = await scratch();
  const home = await scratch();
  const binDir = join(home, '.local', 'bin');
  await installed(root, '0.4.0');
  const result = await linkVersion({
    version: '0.4.0',
    root,
    binDir,
    home,
    platform: 'darwin',
    run: async () => {
      throw new Error('sudo exited with status 1.');
    },
  });
  assert.equal(result.pathEntry, 'failed');
  assert.equal(await currentVersion(root), '0.4.0');
  assert.equal(await readlink(join(binDir, 'foggy')), join(root, 'current', 'bin', 'foggy.mjs'));
});

test('ensurePathEntry appends one marked line to ~/.profile on Linux and skips an existing one', async () => {
  const home = await scratch();
  const binDir = join(home, '.local', 'bin');
  const profile = join(home, '.profile');
  await writeFile(profile, 'export EDITOR=vi');
  assert.equal(await ensurePathEntry({ platform: 'linux', home, binDir }), 'created');
  assert.equal(
    await readFile(profile, 'utf8'),
    `export EDITOR=vi\nexport PATH="${binDir}:$PATH" # foggybrain\n`,
  );
  assert.equal(await ensurePathEntry({ platform: 'linux', home, binDir }), 'present');
  assert.equal(
    (await readFile(profile, 'utf8')).match(/# foggybrain/g)?.length,
    1,
    'a second run must not duplicate the line',
  );

  const fresh = await scratch();
  assert.equal(
    await ensurePathEntry({ platform: 'linux', home: fresh, binDir: join(fresh, '.local', 'bin') }),
    'created',
  );
  assert.match(await readFile(join(fresh, '.profile'), 'utf8'), /^export PATH=/);
});

test('execute resolves on a zero exit and rejects with the exit status otherwise', async () => {
  await execute(process.execPath, ['-e', 'process.exit(0)']);
  await assert.rejects(
    () => execute(process.execPath, ['-e', 'process.exit(3)']),
    /exited with status 3/,
  );
});

test('ensurePathEntry writes /etc/paths.d/foggy through sudo on macOS and skips a correct one', async () => {
  const home = await scratch();
  const binDir = join(home, '.local', 'bin');
  const pathsFile = join(home, 'paths.d-foggy');
  const calls: { file: string; args: string[]; input?: string }[] = [];
  const run = async (file: string, args: string[], input?: string) => {
    calls.push({ file, args, input });
    await writeFile(pathsFile, input ?? '');
  };
  const created = await ensurePathEntry({ platform: 'darwin', home, binDir, run, pathsFile });
  assert.equal(created, 'created');
  assert.deepEqual(calls, [
    { file: 'sudo', args: ['/usr/bin/tee', pathsFile], input: `${binDir}\n` },
  ]);
  assert.equal(
    await ensurePathEntry({ platform: 'darwin', home, binDir, run, pathsFile }),
    'present',
  );
  assert.equal(calls.length, 1);
});

async function archive(version: string): Promise<Buffer> {
  const stage = await scratch();
  const top = join(stage, `foggybrain-${version}`);
  await mkdir(join(top, 'bin'), { recursive: true });
  await mkdir(join(top, 'dist', 'server'), { recursive: true });
  await writeFile(join(top, 'bin', 'foggy.mjs'), '#!/usr/bin/env node\n', { mode: 0o755 });
  await writeFile(join(top, 'dist', 'server', 'cli.js'), `export const version = '${version}';\n`);
  await writeFile(join(top, 'package.json'), JSON.stringify({ version }));
  await promisify(execFile)('tar', [
    '-czf',
    join(stage, 'a.tar.gz'),
    '-C',
    stage,
    `foggybrain-${version}`,
  ]);
  return readFile(join(stage, 'a.tar.gz'));
}

function releaseFetch(assets: Record<string, Buffer>, latest?: string): typeof fetch {
  const sums = Object.entries(assets)
    .map(
      ([version, bytes]) =>
        `${createHash('sha256').update(bytes).digest('hex')}  foggybrain-${version}.tar.gz`,
    )
    .join('\n');
  return (async (input: string) => {
    const url = String(input);
    if (url.endsWith('/releases/latest'))
      return new Response(JSON.stringify({ tag_name: `v${latest ?? Object.keys(assets)[0]}` }), {
        status: 200,
      });
    if (url.endsWith('/SHA256SUMS')) return new Response(`${sums}\n`, { status: 200 });
    const version = Object.keys(assets).find((key) => url === releaseAssetUrl(key));
    if (version === undefined) return new Response('not found', { status: 404 });
    return new Response(new Uint8Array(assets[version]!), { status: 200 });
  }) as unknown as typeof fetch;
}

test('releaseAssetUrl and resolveLatestVersion use the public release endpoints', async () => {
  assert.equal(
    releaseAssetUrl('1.2.3'),
    'https://github.com/LLuque-twilio/foggybrain/releases/download/v1.2.3/foggybrain-1.2.3.tar.gz',
  );
  const requested: string[] = [];
  const fetchImpl = (async (input: string) => {
    requested.push(String(input));
    return new Response(JSON.stringify({ tag_name: 'v0.4.1' }), { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal(await resolveLatestVersion(fetchImpl), '0.4.1');
  assert.deepEqual(requested, [
    'https://api.github.com/repos/LLuque-twilio/foggybrain/releases/latest',
  ]);
  const failing = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(() => resolveLatestVersion(failing), /release/i);
});

test('upgrade downloads, extracts, links, and reports the previous version', async () => {
  const root = await scratch();
  const home = await scratch();
  const binDir = join(home, '.local', 'bin');
  const fetchImpl = releaseFetch({ '0.3.0': await archive('0.3.0') });
  const first = await upgrade({ root, home, binDir, platform: 'linux', fetchImpl });
  assert.equal(first.version, '0.3.0');
  assert.equal(first.previousVersion, null);
  assert.equal(await currentVersion(root), '0.3.0');
  assert.equal(
    await readFile(join(versionDirectory('0.3.0', root), 'dist', 'server', 'cli.js'), 'utf8'),
    "export const version = '0.3.0';\n",
  );

  // Re-running the same version is safe and keeps the old directory in place for rollback.
  const again = await upgrade({
    version: 'v0.3.0',
    root,
    home,
    binDir,
    platform: 'linux',
    fetchImpl,
  });
  assert.equal(again.previousVersion, '0.3.0');
  assert.equal(await currentVersion(root), '0.3.0');
});

test('downloadVersion rejects an archive without the foggy executable', async () => {
  const root = await scratch();
  const stage = await scratch();
  await mkdir(join(stage, 'foggybrain-0.5.0'), { recursive: true });
  await writeFile(join(stage, 'foggybrain-0.5.0', 'README'), 'x');
  await promisify(execFile)('tar', [
    '-czf',
    join(stage, 'a.tar.gz'),
    '-C',
    stage,
    'foggybrain-0.5.0',
  ]);
  const bytes = await readFile(join(stage, 'a.tar.gz'));
  const fetchImpl = releaseFetch({ '0.5.0': bytes });
  await assert.rejects(() => downloadVersion('0.5.0', { root, fetchImpl }), /archive/i);
});

test('checksumFor reads only an exact asset entry out of a SHA256SUMS file', () => {
  const digest = 'a'.repeat(64);
  const other = 'b'.repeat(64);
  const sums = [
    `${other}  foggybrain-1.0.0.tar.gz.asc`,
    `${digest}  foggybrain-1.0.0.tar.gz`,
    `${other} *foggybrain-1.1.0.tar.gz`,
  ].join('\n');
  assert.equal(checksumFor(sums, 'foggybrain-1.0.0.tar.gz'), digest);
  assert.equal(checksumFor(sums, 'foggybrain-1.1.0.tar.gz'), other);
  assert.equal(checksumFor(sums, 'foggybrain-2.0.0.tar.gz'), null);
  assert.equal(
    checksumFor(`${'A'.repeat(64)}  foggybrain-1.0.0.tar.gz`, 'foggybrain-1.0.0.tar.gz'),
    null,
  );
});

test('downloadVersion refuses an archive whose digest does not match SHA256SUMS', async () => {
  const root = await scratch();
  const bytes = await archive('0.6.0');
  const tampered = Buffer.from(bytes);
  tampered[tampered.length - 1] ^= 0xff;
  const expected = createHash('sha256').update(bytes).digest('hex');
  const got = createHash('sha256').update(tampered).digest('hex');
  const fetchImpl = (async (input: string) => {
    const url = String(input);
    if (url === releaseChecksumUrl('0.6.0'))
      return new Response(`${expected}  foggybrain-0.6.0.tar.gz\n`, { status: 200 });
    return new Response(new Uint8Array(tampered), { status: 200 });
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => downloadVersion('0.6.0', { root, fetchImpl }),
    new RegExp(`Checksum mismatch for foggybrain-0.6.0.tar.gz: expected ${expected}, got ${got}`),
  );
  await assert.rejects(() => stat(versionDirectory('0.6.0', root)), /ENOENT/);
});

test('downloadVersion refuses a release whose SHA256SUMS omits the asset', async () => {
  const root = await scratch();
  const bytes = await archive('0.7.0');
  const fetchImpl = (async (input: string) => {
    if (String(input) === releaseChecksumUrl('0.7.0'))
      return new Response(`${'c'.repeat(64)}  foggybrain-0.7.1.tar.gz\n`, { status: 200 });
    return new Response(new Uint8Array(bytes), { status: 200 });
  }) as unknown as typeof fetch;
  await assert.rejects(() => downloadVersion('0.7.0', { root, fetchImpl }), /no entry for/);
});

test('downloadVersion fails when the release has no SHA256SUMS at all', async () => {
  const root = await scratch();
  const fetchImpl = (async (input: string) =>
    String(input).endsWith('/SHA256SUMS')
      ? new Response('missing', { status: 404 })
      : new Response(new Uint8Array(await archive('0.8.0')), {
          status: 200,
        })) as unknown as typeof fetch;
  await assert.rejects(() => downloadVersion('0.8.0', { root, fetchImpl }), /checksums.*HTTP 404/);
});

test('upgrading to a different version keeps the previous version directory for rollback', async () => {
  const root = await scratch();
  const home = await scratch();
  const binDir = join(home, '.local', 'bin');
  const fetchImpl = releaseFetch(
    { '0.9.0': await archive('0.9.0'), '0.9.1': await archive('0.9.1') },
    '0.9.1',
  );
  const options = { root, home, binDir, platform: 'linux' as const, fetchImpl };
  await upgrade({ ...options, version: '0.9.0' });
  const moved = await upgrade(options);
  assert.equal(moved.version, '0.9.1');
  assert.equal(moved.previousVersion, '0.9.0');
  assert.equal(await currentVersion(root), '0.9.1');
  assert.equal(
    await readFile(join(versionDirectory('0.9.0', root), 'dist', 'server', 'cli.js'), 'utf8'),
    "export const version = '0.9.0';\n",
  );
});

test('removePathEntry deletes the macOS paths.d file and strips only the marked profile line', async () => {
  const home = await scratch();
  const binDir = join(home, '.local', 'bin');
  const pathsFile = join(home, 'paths.d-foggy');
  await writeFile(pathsFile, `${binDir}\n`);
  const calls: string[][] = [];
  const run = async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    await rm(args.at(-1)!, { force: true });
  };
  assert.equal(
    await removePathEntry({ platform: 'darwin', home, binDir, run, pathsFile }),
    'removed',
  );
  assert.deepEqual(calls, [['sudo', '/bin/rm', '-f', pathsFile]]);
  assert.equal(
    await removePathEntry({ platform: 'darwin', home, binDir, run, pathsFile }),
    'absent',
  );
  assert.equal(calls.length, 1);

  const profile = join(home, '.profile');
  await writeFile(
    profile,
    `# mine\nexport EDITOR=vi\nexport PATH="${binDir}:$PATH" # foggybrain\nexport LANG=C\n`,
  );
  assert.equal(await removePathEntry({ platform: 'linux', home, binDir, run }), 'removed');
  assert.equal(await readFile(profile, 'utf8'), '# mine\nexport EDITOR=vi\nexport LANG=C\n');
  assert.equal(await removePathEntry({ platform: 'linux', home, binDir, run }), 'absent');
});

test('uninstall removes the install root, its executable, and the PATH entry, keeping task data', async () => {
  const root = await scratch();
  const home = await scratch();
  const binDir = join(home, '.local', 'bin');
  const dataDir = await scratch();
  await installed(root, '0.1.0');
  await mkdir(binDir, { recursive: true });
  await symlink(join(root, 'current', 'bin', 'foggy.mjs'), join(binDir, 'foggy'));
  await symlink(versionDirectory('0.1.0', root), join(root, 'current'));
  await writeFile(join(dataDir, 'foggybrain.sqlite'), 'data');
  const profile = join(home, '.profile');
  await writeFile(profile, `export PATH="${binDir}:$PATH" # foggybrain\n`);

  const result = await uninstall({
    root,
    binDir,
    home,
    platform: 'linux',
    env: { FOGGY_DATA_DIR: dataDir },
  });
  assert.deepEqual(result.removed.sort(), [join(binDir, 'foggy'), root].sort());
  assert.equal(result.pathEntry, 'removed');
  assert.equal(result.keptDataDir, dataDir);
  await assert.rejects(() => stat(root), /ENOENT/);
  await assert.rejects(() => stat(join(binDir, 'foggy')), /ENOENT/);
  assert.equal(await readFile(join(dataDir, 'foggybrain.sqlite'), 'utf8'), 'data');
  assert.equal(await readFile(profile, 'utf8'), '');

  const repeat = await uninstall({
    root,
    binDir,
    home,
    platform: 'linux',
    env: { FOGGY_DATA_DIR: dataDir },
  });
  assert.deepEqual(repeat.removed, []);
  assert.equal(repeat.pathEntry, 'absent');
});

test('uninstall leaves a foggy executable that points outside the install root alone', async () => {
  const root = await scratch();
  const home = await scratch();
  const other = await scratch();
  const binDir = join(home, '.local', 'bin');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(other, 'foggy.mjs'), '#!/usr/bin/env node\n');
  await symlink(join(other, 'foggy.mjs'), join(binDir, 'foggy'));
  const result = await uninstall({
    root,
    binDir,
    home,
    platform: 'linux',
    env: { FOGGY_DATA_DIR: other },
  });
  assert.deepEqual(result.removed, []);
  assert.equal(await readlink(join(binDir, 'foggy')), join(other, 'foggy.mjs'));
});

test('uninstall on a foreign foggy executable reports a real PATH entry instead of assuming it is gone', async () => {
  const root = await scratch();
  const home = await scratch();
  const other = await scratch();
  const binDir = join(home, '.local', 'bin');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(other, 'foggy.mjs'), '#!/usr/bin/env node\n');
  await symlink(join(other, 'foggy.mjs'), join(binDir, 'foggy'));

  const profile = join(home, '.profile');
  const profileContents = `export PATH="${binDir}:$PATH" # foggybrain\n`;
  await writeFile(profile, profileContents);
  const linuxResult = await uninstall({
    root,
    binDir,
    home,
    platform: 'linux',
    env: { FOGGY_DATA_DIR: other },
  });
  assert.deepEqual(linuxResult.removed, []);
  assert.equal(linuxResult.pathEntry, 'present');
  assert.equal(await readFile(profile, 'utf8'), profileContents);

  const pathsFile = join(home, 'paths.d-foggy');
  await writeFile(pathsFile, `${binDir}\n`);
  const darwinResult = await uninstall({
    root,
    binDir,
    home,
    platform: 'darwin',
    pathsFile,
    env: { FOGGY_DATA_DIR: other },
  });
  assert.deepEqual(darwinResult.removed, []);
  assert.equal(darwinResult.pathEntry, 'present');
  assert.equal(await readFile(pathsFile, 'utf8'), `${binDir}\n`);
});

test('uninstall leaves a regular-file foggy shim and its PATH entry alone', async () => {
  const root = await scratch();
  const home = await scratch();
  const binDir = join(home, '.local', 'bin');
  await mkdir(binDir, { recursive: true });
  await installed(root, '0.1.0');
  const shim = join(binDir, 'foggy');
  await writeFile(shim, '#!/bin/sh\nexec other-foggy "$@"\n', { mode: 0o755 });
  const profile = join(home, '.profile');
  await writeFile(profile, `export PATH="${binDir}:$PATH" # foggybrain\n`);

  const result = await uninstall({
    root,
    binDir,
    home,
    platform: 'linux',
    env: { FOGGY_DATA_DIR: await scratch() },
  });
  assert.deepEqual(result.removed, []);
  assert.equal(result.pathEntry, 'present');
  assert.match(await readFile(shim, 'utf8'), /other-foggy/);
  assert.ok(await stat(root));
});

test('uninstall ignores a paths.d file that points at another user bin directory', async () => {
  const home = await scratch();
  const root = await scratch();
  const binDir = join(home, '.local', 'bin');
  const pathsFile = join(home, 'paths.d-foggy');
  await writeFile(pathsFile, '/Users/someone-else/.local/bin\n');
  const calls: string[][] = [];
  const result = await uninstall({
    root,
    binDir,
    home,
    platform: 'darwin',
    pathsFile,
    run: async (file, args) => {
      calls.push([file, ...args]);
    },
    env: { FOGGY_DATA_DIR: await scratch() },
  });
  assert.equal(result.pathEntry, 'absent');
  assert.deepEqual(calls, []);
  assert.equal(await readFile(pathsFile, 'utf8'), '/Users/someone-else/.local/bin\n');
});
