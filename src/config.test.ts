import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CONFIG_KEYS,
  applyConfigFile,
  assertConfigKey,
  assertConfigValue,
  configFilePath,
  describeSettings,
  loadConfigFile,
  maskSecret,
  readConfigFile,
  writeConfigFile,
  type ConfigValues,
} from './config.js';

const scratch = () => mkdtemp(join(tmpdir(), 'foggy-config-'));

test('configFilePath sits in the install root and follows FOGGY_HOME', () => {
  assert.equal(configFilePath({}, '/home/x'), '/home/x/.foggybrain/config.json');
  assert.equal(configFilePath({ FOGGY_HOME: '/tmp/fh' }, '/home/x'), '/tmp/fh/config.json');
});

test('the settable keys exclude the variables that cannot live in the file', () => {
  const names = CONFIG_KEYS.map((key) => key.name);
  assert.deepEqual(names, [
    'GH_TOKEN',
    'FOGGY_SYNC_TOKEN',
    'FOGGY_SYNC_REPO',
    'FOGGY_SYNC_BRANCH',
    'FOGGY_SYNC_PATH',
    'FOGGY_PORT',
    'FOGGY_DATA_DIR',
    'FOGGY_POLL_INTERVAL_MS',
    'FOGGY_URL',
    'FOGGY_WORKSPACE',
  ]);
  for (const excluded of ['FOGGY_HOME', 'GITHUB_TOKEN', 'FOGGY_VERSION', 'FOGGY_FORCE'])
    assert.ok(!names.includes(excluded), excluded);
  assert.deepEqual(
    CONFIG_KEYS.filter((key) => key.secret).map((key) => key.name),
    ['GH_TOKEN', 'FOGGY_SYNC_TOKEN'],
  );
});

test('assertConfigKey rejects unknown and non-settable names', () => {
  assert.equal(assertConfigKey('FOGGY_PORT').name, 'FOGGY_PORT');
  for (const bad of ['', 'foggy_port', 'FOGGY_HOME', 'PATH'])
    assert.throws(() => assertConfigKey(bad), /not a FoggyBrain configuration key/i, bad);
});

test('assertConfigValue applies the same rules the server enforces at startup', () => {
  assertConfigValue('FOGGY_PORT', '5000');
  assert.throws(() => assertConfigValue('FOGGY_PORT', '0'), /between 1 and 65535/);
  assert.throws(() => assertConfigValue('FOGGY_PORT', '70000'), /between 1 and 65535/);
  assert.throws(() => assertConfigValue('FOGGY_PORT', 'x'), /between 1 and 65535/);

  assertConfigValue('FOGGY_POLL_INTERVAL_MS', '15000');
  assert.throws(() => assertConfigValue('FOGGY_POLL_INTERVAL_MS', '1000'), /15000/);

  assertConfigValue('FOGGY_SYNC_REPO', 'owner/state');
  assert.throws(() => assertConfigValue('FOGGY_SYNC_REPO', 'nope'), /repository/i);

  assertConfigValue('FOGGY_SYNC_TOKEN', 'github_pat_abc');
  assert.throws(() => assertConfigValue('FOGGY_SYNC_TOKEN', 'has space'), /ASCII/i);

  assertConfigValue('FOGGY_URL', 'http://127.0.0.1:4173');
  assert.throws(() => assertConfigValue('FOGGY_URL', 'http://x/path'), /origin/i);

  assert.throws(() => assertConfigValue('FOGGY_DATA_DIR', '   '), /must not be empty/i);
  assert.throws(() => assertConfigValue('GH_TOKEN', ''), /must not be empty/i);
  assert.throws(() => assertConfigValue('GH_TOKEN', 'tok\nen'), /single line/i);
});

test('readConfigFile returns an empty map when the file is missing', async () => {
  const root = await scratch();
  assert.deepEqual(await readConfigFile(join(root, 'config.json')), {});
});

test('writeConfigFile creates the directory, round-trips, and keeps the file private', async () => {
  const root = await scratch();
  const path = join(root, 'nested', 'config.json');
  await writeConfigFile({ FOGGY_PORT: '5000', GH_TOKEN: 'ghp_x' }, path);
  assert.deepEqual(await readConfigFile(path), { FOGGY_PORT: '5000', GH_TOKEN: 'ghp_x' });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.match(await readFile(path, 'utf8'), /\n$/);
});

test('readConfigFile rejects a file that is not a flat map of known keys', async () => {
  const root = await scratch();
  const path = join(root, 'config.json');
  for (const [body, pattern] of [
    ['not json', /valid JSON/i],
    ['[]', /JSON object/i],
    ['{"FOGGY_PORT":5000}', /string/i],
    ['{"NOPE":"x"}', /not a FoggyBrain configuration key/i],
    ['{"FOGGY_PORT":"0"}', /between 1 and 65535/],
  ] as const) {
    await writeFile(path, body);
    await assert.rejects(readConfigFile(path), pattern, body);
    // Every rejection names the file, or there is no way to know what to go and fix.
    await assert.rejects(readConfigFile(path), new RegExp(path.replace(/\./g, '\\.')), body);
  }
});

test('loadConfigFile keeps the usable entries and reports the rest instead of throwing', async () => {
  const root = await scratch();
  const path = join(root, 'config.json');
  await writeFile(
    path,
    JSON.stringify({ FOGGY_PORT: '0', FOGGY_WORKSPACE: 'ws-1', NOPE: 'x', GH_TOKEN: 5 }),
  );

  const loaded = await loadConfigFile(path);

  assert.deepEqual(loaded.values, { FOGGY_WORKSPACE: 'ws-1' });
  assert.equal(loaded.problems.length, 3);
  assert.ok(loaded.problems.every((problem) => problem.startsWith(`${path}: `)));
  assert.match(loaded.problems[0], /between 1 and 65535/);
  assert.match(loaded.problems[1], /not a FoggyBrain configuration key/);
  assert.match(loaded.problems[2], /must be a string/);
});

test('loadConfigFile reports a file it cannot parse at all without losing the path', async () => {
  const root = await scratch();
  const path = join(root, 'config.json');
  for (const body of ['not json', '[]']) {
    await writeFile(path, body);
    const loaded = await loadConfigFile(path);
    assert.deepEqual(loaded.values, {});
    assert.equal(loaded.problems.length, 1);
    assert.ok(loaded.problems[0].includes(path), body);
  }
  assert.deepEqual(await loadConfigFile(join(root, 'missing.json')), { values: {}, problems: [] });
});

test('applyConfigFile fills gaps without overriding the process environment', () => {
  const env: NodeJS.ProcessEnv = { FOGGY_PORT: '9000' };
  applyConfigFile(env, { FOGGY_PORT: '5000', GH_TOKEN: 'ghp_x' });
  assert.equal(env.FOGGY_PORT, '9000');
  assert.equal(env.GH_TOKEN, 'ghp_x');
});

test('maskSecret keeps only the tail and never leaks a short value', () => {
  assert.equal(maskSecret('ghp_abcdefgh3f2a'), '****3f2a');
  assert.equal(maskSecret('short'), '****');
});

test('describeSettings names where each value comes from', () => {
  const values = { FOGGY_PORT: '5000', GH_TOKEN: 'ghp_abcdefgh3f2a' };
  const env: NodeJS.ProcessEnv = { FOGGY_PORT: '5000', GH_TOKEN: 'ghp_abcdefgh3f2a' };
  env.FOGGY_URL = 'http://127.0.0.1:9999';
  const rows = describeSettings(env, values, { ghToken: false, home: '/home/x' });
  const row = (name: string) => rows.find((entry) => entry.name === name)!;

  assert.equal(rows.length, CONFIG_KEYS.length);
  assert.deepEqual(row('FOGGY_PORT'), { name: 'FOGGY_PORT', value: '5000', source: 'config' });
  assert.deepEqual(row('FOGGY_URL'), {
    name: 'FOGGY_URL',
    value: 'http://127.0.0.1:9999',
    source: 'environment',
  });
  assert.deepEqual(row('FOGGY_SYNC_BRANCH'), {
    name: 'FOGGY_SYNC_BRANCH',
    value: 'main',
    source: 'default',
  });
  assert.deepEqual(row('FOGGY_DATA_DIR'), {
    name: 'FOGGY_DATA_DIR',
    value: '/home/x/.local/share/foggybrain',
    source: 'default',
  });
  assert.deepEqual(row('FOGGY_WORKSPACE'), {
    name: 'FOGGY_WORKSPACE',
    value: null,
    source: 'unset',
  });
  assert.deepEqual(row('GH_TOKEN'), {
    name: 'GH_TOKEN',
    value: '****3f2a',
    source: 'config',
  });
});

test('describeSettings reports the gh CLI fallback only when nothing else supplies a token', () => {
  const rows = describeSettings({}, {}, { ghToken: true, home: '/home/x' });
  const row = (name: string) => rows.find((entry) => entry.name === name)!;
  assert.deepEqual(row('GH_TOKEN'), {
    name: 'GH_TOKEN',
    value: '****',
    source: 'gh auth token',
  });
  assert.equal(row('FOGGY_SYNC_TOKEN').source, 'unset');
  assert.equal(
    describeSettings({ GH_TOKEN: 'ghp_abcdefgh3f2a' }, {}, { ghToken: true, home: '/home/x' }).find(
      (entry) => entry.name === 'GH_TOKEN',
    )!.source,
    'environment',
  );
});

test('describeSettings resolves GH_TOKEN exactly the way the server does', () => {
  const gh = (env: NodeJS.ProcessEnv, values: ConfigValues = {}, ghToken = false) =>
    describeSettings(env, values, { ghToken, home: '/home/x' }).find(
      (entry) => entry.name === 'GH_TOKEN',
    )!;

  // The server reads `env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || gh auth token`.
  assert.deepEqual(gh({ GITHUB_TOKEN: 'ghp_abcdefgh3f2a' }), {
    name: 'GH_TOKEN',
    value: '****3f2a',
    source: 'GITHUB_TOKEN',
  });
  assert.equal(gh({ GH_TOKEN: '  ', GITHUB_TOKEN: 'ghp_abcdefgh3f2a' }).source, 'GITHUB_TOKEN');
  assert.equal(gh({ GH_TOKEN: '  ' }, {}, true).source, 'gh auth token');
  assert.equal(gh({ GH_TOKEN: '' }).source, 'unset');
  assert.equal(gh({ GH_TOKEN: 'ghp_abcdefgh3f2a', GITHUB_TOKEN: 'other' }).source, 'environment');
});

test('describeSettings consults the gh CLI only when it could change the answer', () => {
  let probes = 0;
  const probe = () => {
    probes += 1;
    return true;
  };
  describeSettings({ GH_TOKEN: 'ghp_abcdefgh3f2a' }, {}, { ghToken: probe, home: '/home/x' });
  assert.equal(probes, 0, 'a token that is already resolved must not shell out to gh');

  const rows = describeSettings({}, {}, { ghToken: probe, home: '/home/x' });
  assert.equal(probes, 1);
  assert.equal(rows.find((entry) => entry.name === 'GH_TOKEN')!.source, 'gh auth token');
});

test('describeSettings can reveal secrets on request', () => {
  const rows = describeSettings(
    {},
    { GH_TOKEN: 'ghp_abcdefgh3f2a' },
    {
      ghToken: false,
      home: '/home/x',
      showSecrets: true,
    },
  );
  assert.equal(rows.find((entry) => entry.name === 'GH_TOKEN')!.value, 'ghp_abcdefgh3f2a');
});
