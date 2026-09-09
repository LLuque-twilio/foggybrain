import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const generator = fileURLToPath(new URL('./homebrew.mjs', import.meta.url));
const metadata = {
  name: 'foggybrain',
  private: true,
  version: '12.34.56',
  bin: { foggy: './bin/foggy.mjs' },
  scripts: { prepack: 'exit 99' },
};

async function fixture(t, value = metadata) {
  const directory = await mkdtemp(join(tmpdir(), 'foggy-homebrew-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'package'));
  await writeFile(join(directory, 'package/package.json'), JSON.stringify(value));
  const archive = join(directory, 'arbitrary archive name.tgz');
  await mkdir(join(directory, 'Formula'));
  const output = join(directory, 'Formula/foggybrain.rb');
  execFileSync('tar', ['-czf', archive, '-C', directory, 'package']);
  return { directory, archive, output };
}

function generate(...args) {
  return spawnSync(process.execPath, [generator, ...args], { encoding: 'utf8' });
}

test('generates a stable formula from archive metadata and actual bytes, with valid Ruby syntax', async (t) => {
  const { archive, output } = await fixture(t);
  const result = generate(archive, output);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  const formula = await readFile(output, 'utf8');
  const hash = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  assert.ok(formula.startsWith('class Foggybrain < Formula\n'));
  assert.ok(
    formula.includes(
      'https://github.com/LLuque-twilio/foggybrain/releases/download/v12.34.56/foggybrain-12.34.56.tgz',
    ),
  );
  assert.ok(formula.includes(`sha256 "${hash}"`));
  assert.match(formula, /homepage "https:\/\/github.com\/LLuque-twilio\/foggybrain"/);
  assert.match(formula, /license "MIT"/);
  assert.doesNotMatch(formula, /^\s*version /m);
  assert.match(formula, /depends_on "node@22"/);
  assert.match(formula, /std_npm_args\(prefix: libexec\)/);
  for (const flag of ['--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund']) {
    assert.ok(formula.includes(`"${flag}"`));
  }
  assert.match(formula, /ENV\["npm_config_ignore_scripts"\] = "true"/);
  assert.match(formula, /bin.install libexec\/"bin\/foggy"/);
  assert.ok(
    formula.includes(
      'bin.env_script_all_files libexec/"bin", PATH: "#{formula_opt_bin("node@22")}:$PATH"',
    ),
  );
  assert.doesNotMatch(formula, /Formula\[/);
  assert.match(formula, /home = testpath\/"home"/);
  assert.match(formula, /ENV\["HOME"\] = home.to_s/);
  assert.doesNotMatch(formula, /ENV\[[^\]\n]+\](?! =)/);
  assert.match(formula, /refute_path_exists home\/"data"/);
  assert.match(formula, /refute_path_exists home\/".config\/foggybrain\/.env"/);
  for (const line of formula.split('\n')) assert.ok(line.length < 118, line);
  assert.match(formula, /ENV\["PATH"\] = "\/usr\/bin:\/bin"/);
  assert.match(formula, /ENV.keys.grep\(\/\\A\(\?:FOGGY_\|GH_\|GITHUB_\|XDG_\|NODE_\)/);
  for (const key of ['GH_CONFIG_DIR', 'FOGGY_DATA_DIR', 'XDG_STATE_HOME']) {
    assert.ok(formula.includes(`"${key}"`));
  }
  assert.match(
    formula,
    /%w\[GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN FOGGY_SYNC_TOKEN\]/,
  );
  assert.match(formula, /foggy --help/);
  assert.match(formula, /"--json", "setup"/);
  assert.match(formula, /"--json", "stop"/);
  assert.match(formula, /"stopped" => \[\], "ignored" => 0/);
  assert.doesNotMatch(formula, /"--json", "(?:graph|workspace|dashboard)"/);
  const ruby = spawnSync('ruby', ['-c', output], { encoding: 'utf8' });
  assert.equal(ruby.status, 0, ruby.error?.message ?? ruby.stderr);
  assert.match(ruby.stdout, /Syntax OK/);
});

test('rejects invalid package metadata without replacing an existing formula', async (t) => {
  const invalid = [
    null,
    { ...metadata, name: 'other' },
    { ...metadata, private: false },
    { ...metadata, private: 'true' },
    { ...metadata, bin: undefined },
    { ...metadata, bin: './bin/foggy.mjs' },
    { ...metadata, bin: { foggy: './dist/cli.js' } },
    { ...metadata, bin: { foggy: './bin/foggy.mjs', extra: './bin/extra.mjs' } },
    ...[
      undefined,
      123,
      '1.2',
      'v1.2.3',
      '01.2.3',
      '1.02.3',
      '1.2.03',
      '1.2.3-rc.1',
      '1.2.3+build',
      '1.2.3\n',
      '#{system("false")}',
    ].map((version) => ({ ...metadata, version })),
  ];
  for (const value of invalid) {
    const { archive, output } = await fixture(t, value);
    await writeFile(output, 'existing formula');
    const result = generate(archive, output);
    assert.equal(result.status, 1, JSON.stringify(value));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Expected (?:private package|a stable numeric)/);
    assert.equal(await readFile(output, 'utf8'), 'existing formula');
  }
});

test('reports usage, archive, JSON, and output errors', async (t) => {
  const { directory, archive, output } = await fixture(t);
  for (const args of [[], [archive], [archive, output, 'extra']]) {
    const result = generate(...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
  assert.equal(generate(join(directory, 'missing.tgz'), output).status, 1);
  assert.equal(generate(archive, join(directory, 'missing/output.rb')).status, 1);
  const original = await readFile(archive);
  assert.equal(generate(archive, archive).status, 1);
  assert.deepEqual(await readFile(archive), original);
  await writeFile(join(directory, 'package/package.json'), 'not JSON');
  execFileSync('tar', ['-czf', archive, '-C', directory, 'package']);
  assert.equal(generate(archive, output).status, 1);
  await writeFile(archive, 'not a tarball');
  assert.equal(generate(archive, output).status, 1);
  await assert.rejects(readFile(output), { code: 'ENOENT' });
});
