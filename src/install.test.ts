import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  assertVersion,
  binDirectory,
  currentVersion,
  ensurePathEntry,
  installRoot,
  linkVersion,
  packageVersion,
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
