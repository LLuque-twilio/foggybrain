import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse } from 'dotenv';
import { encodeSetupValue, updateSetupConfig } from './setup.js';

const cwd = fileURLToPath(new URL('..', import.meta.url));
async function fixture(t: TestContext, source?: string) {
  const home = await mkdtemp(join(tmpdir(), 'foggy-setup-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, '.config', 'foggybrain');
  const path = join(directory, '.env');
  if (source !== undefined) {
    await mkdir(directory, { recursive: true });
    await writeFile(path, source);
  }
  return { home, directory, path };
}

async function run(
  home: string,
  args: string[] = ['setup'],
  answers?: string[],
  extraEnv: NodeJS.ProcessEnv = {},
  hook = '',
  options: { realTerminal?: boolean; beforeImport?: string; cwd?: string } = {},
) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const key of Object.keys(env))
    if (key.startsWith('FOGGY_') || ['GH_TOKEN', 'GITHUB_TOKEN', 'NODE_OPTIONS'].includes(key))
      delete env[key];
  Object.assign(env, extraEnv);
  const code = `
    import assert from 'node:assert/strict';
    import readline from 'node:readline/promises';
    import childProcess from 'node:child_process';
    import { EventEmitter } from 'node:events';
    import { syncBuiltinESMExports } from 'node:module';
    import { writeFileSync, unlinkSync, symlinkSync, renameSync } from 'node:fs';
    import fsPromises from 'node:fs/promises';
    import { PassThrough } from 'node:stream';
    const answers = ${JSON.stringify(answers ?? null)};
    globalThis.fetch = () => { throw new Error('Unexpected network access'); };
    childProcess.spawn = () => { throw new Error('Unexpected server startup'); };
    const realTerminal = ${!!options.realTerminal};
    const createInterface = readline.createInterface;
    if (realTerminal) {
      const input = new PassThrough();
      Object.defineProperty(process, 'stdin', { value: input });
    }
    if (answers) {
      Object.defineProperty(process.stdin, 'isTTY', { value: true });
      Object.defineProperty(process.stderr, 'isTTY', { value: true });
      readline.createInterface = options => {
        assert.equal(options.terminal, true);
        assert.equal(options.historySize, 0);
        if (realTerminal) {
          const terminal = createInterface(options);
          const question = terminal.question.bind(terminal);
          terminal.question = (prompt, questionOptions) => {
            assert.ok(answers.length, 'Unexpected prompt: ' + prompt);
            const answer = answers.shift();
            const result = question(prompt, questionOptions);
            setImmediate(() => {
              if (answer === 'EOF') process.stdin.end();
              else process.stdin.write(answer === 'SIGINT' ? '\\x03' : answer + '\\r');
            });
            return result;
          };
          return terminal;
        }
        const terminal = new EventEmitter();
        terminal.close = () => terminal.emit('close');
        terminal.question = (prompt, questionOptions) => {
          options.output.write(prompt);
          assert.ok(answers.length, 'Unexpected prompt: ' + prompt);
          const answer = answers.shift();
          if (answer === 'EOF' || answer === 'SIGINT') return new Promise((resolve, reject) => {
            questionOptions.signal.addEventListener('abort', () => reject(new Error('aborted')));
            queueMicrotask(() => terminal.emit(answer === 'EOF' ? 'close' : 'SIGINT'));
          });
          if (prompt.includes('Type yes')) { ${hook} }
          options.output.write(answer + '\\n');
          return Promise.resolve(answer);
        };
        return terminal;
      };
    }
    ${options.beforeImport ?? ''}
    syncBuiltinESMExports();
    const { main } = await import(${JSON.stringify(new URL('./cli.ts', import.meta.url).href)});
    await main(['node', 'foggy', ...${JSON.stringify(args)}]);
  `;
  return promisify(execFile)(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', code],
    { cwd: options.cwd ?? cwd, env, timeout: 30_000 },
  ).then(
    (result) => ({ ...result, code: 0 }),
    (error: { code: number; stdout: string; stderr: string }) => error,
  );
}

const defaults = ['', '', '', '', '', '', 'yes'];

test('real readline cannot yank killed secrets into later visible prompts', async (t) => {
  const { home, path, directory } = await fixture(t);
  const result = await run(
    home,
    ['setup'],
    [
      'replace',
      'discarded-pr-secret\x15saved-pr-secret',
      '\x19replace',
      'discarded-sync-secret\x15saved-sync-secret',
      '\x194173',
      '',
      '',
      '',
      'yes',
    ],
    {},
    '',
    { realTerminal: true },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /(?:discarded|saved)-(?:pr|sync)-secret/);
  assert.doesNotMatch(result.stderr, /Invalid choice|Invalid port|Setup cancelled/);
  assert.match(result.stderr, /FOGGY_SYNC_TOKEN \(not configured\)/);
  assert.match(result.stderr, /API port/);
  const values = parse(await readFile(path, 'utf8'));
  assert.equal(values.GH_TOKEN, 'saved-pr-secret');
  assert.equal(values.FOGGY_SYNC_TOKEN, 'saved-sync-secret');
  assert.deepEqual(await readdir(directory), ['.env']);
});

test('real readline EOF and Ctrl-C cancel secret prompts without saving or leaking buffers', async (t) => {
  for (const end of ['EOF', 'SIGINT']) {
    const { home, directory } = await fixture(t);
    const result = await run(home, ['setup'], ['replace', end], {}, '', { realTerminal: true });
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /Setup cancelled/);
    assert.deepEqual(await readdir(directory), []);
  }
});

test('source setup validates from a cwd outside the checkout', async (t) => {
  const { home, path } = await fixture(t);
  const result = await run(home, ['setup'], defaults, {}, '', { cwd: home });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parse(await readFile(path, 'utf8')).FOGGY_PORT, '4173');
  assert.doesNotMatch(result.stderr, /ExperimentalWarning|ERR_MODULE_NOT_FOUND/);
});

test('validator subprocess failures never expose raw exceptions from inherited NODE_OPTIONS', async (t) => {
  const { home, path, directory } = await fixture(t, 'OTHER=unchanged\n');
  const preload = join(home, 'failing-preload.cjs');
  await writeFile(preload, "throw new Error('preload-secret-must-not-leak');\n");
  const result = await run(home, ['setup'], defaults, {}, '', {
    beforeImport: `process.env.NODE_OPTIONS = ${JSON.stringify(`--require=${preload}`)};`,
  });
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Configuration validation failed/);
  assert.doesNotMatch(result.stderr, /preload-secret-must-not-leak|failing-preload/);
  assert.equal(await readFile(path, 'utf8'), 'OTHER=unchanged\n');
  assert.deepEqual(await readdir(directory), ['.env']);
});

test('pathname revalidation catches atomic replacement while final snapshot descriptor is open', async (t) => {
  const { home, path, directory } = await fixture(t, 'OTHER=before\n');
  const beforeImport = `
    const open = fsPromises.open;
    let configReads = 0;
    fsPromises.open = async (...args) => {
      const file = await open(...args);
      if (args[0] === ${JSON.stringify(path)} && ++configReads === 2) {
        const readFile = file.readFile.bind(file);
        file.readFile = async (...readArgs) => {
          const bytes = await readFile(...readArgs);
          writeFileSync(${JSON.stringify(path + '.editor')}, 'OTHER=atomic-editor\\n');
          renameSync(${JSON.stringify(path + '.editor')}, ${JSON.stringify(path)});
          return bytes;
        };
      }
      return file;
    };
  `;
  const result = await run(home, ['setup'], defaults, {}, '', { beforeImport });
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /Configuration changed during setup/);
  assert.equal(await readFile(path, 'utf8'), 'OTHER=atomic-editor\n');
  assert.deepEqual(await readdir(directory), ['.env']);
});

test('setup rejects nonTTY, JSON, URL and workspace selection via real Commander without side effects', async (t) => {
  const { home } = await fixture(t);
  for (const [args, env, expected] of [
    [['setup'], {}, /interactive terminal/],
    [['--json', 'setup'], {}, /--json setup/],
    [['setup', '--json'], {}, /--json setup/],
    [['--url', 'http://127.0.0.1:1', 'setup'], {}, /local-only/],
    [['setup'], { FOGGY_URL: '' }, /local-only/],
    [['setup', '--workspace', 'default'], {}, /not a workspace/],
    [['setup'], { FOGGY_WORKSPACE: '' }, /not a workspace/],
  ] as const) {
    const result = await run(home, [...args], undefined, env);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(JSON.parse(result.stderr).error, expected);
  }
  assert.deepEqual(await readdir(home), []);
});

test('guided defaults save private config only and explain explicit user-wide restart', async (t) => {
  const { home, path, directory } = await fixture(t);
  const result = await run(home, ['setup'], defaults);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /ExperimentalWarning|SQLite/);
  assert.match(result.stderr, /foggy stop/);
  assert.match(result.stderr, /user-wide/);
  assert.deepEqual(parse(await readFile(path, 'utf8')), {
    FOGGY_PORT: '4173',
    FOGGY_POLL_INTERVAL_MS: '60000',
  });
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(directory), ['.env']);
  assert.deepEqual(await readdir(home), ['.config']);
});

test('guided replacement hides secrets, retries invalid input, warns names only, and selects data without creating it', async (t) => {
  const { home, path } = await fixture(
    t,
    '# comment\nGITHUB_TOKEN=old-token\nOTHER="keep # this"\n',
  );
  const data = join(home, 'different data');
  const result = await run(
    home,
    ['setup'],
    [
      'wrong',
      'replace',
      'invalid token',
      'secret-PR-#-value',
      'replace',
      'secret-sync-"value',
      '0',
      '5000',
      '14',
      '15.125',
      'replace',
      'relative',
      data,
      '',
      'yes',
    ],
    { GH_TOKEN: 'process-pr-secret', FOGGY_SYNC_TOKEN: 'process-sync-secret', FOGGY_PORT: '9999' },
  );
  assert.equal(result.code, 0, result.stderr);
  for (const secret of [
    'old-token',
    'invalid token',
    'secret-PR-#-value',
    'secret-sync-"value',
    'process-pr-secret',
    'process-sync-secret',
  ])
    assert.ok(!result.stderr.includes(secret), secret);
  assert.match(
    result.stderr,
    /process environment overrides saved settings: GH_TOKEN, FOGGY_SYNC_TOKEN, FOGGY_PORT/,
  );
  assert.match(result.stderr, /Invalid port/);
  assert.match(result.stderr, /Invalid interval/);
  assert.match(result.stderr, /Invalid directory/);
  const source = await readFile(path, 'utf8');
  assert.match(source, /# comment/);
  assert.match(source, /OTHER="keep # this"/);
  assert.deepEqual(parse(source), {
    GH_TOKEN: 'secret-PR-#-value',
    FOGGY_SYNC_TOKEN: 'secret-sync-"value',
    OTHER: 'keep # this',
    FOGGY_PORT: '5000',
    FOGGY_POLL_INTERVAL_MS: '15125',
    FOGGY_DATA_DIR: data,
  });
  await assert.rejects(lstat(data), { code: 'ENOENT' });
});

test('keep preserves both GitHub tokens and legacy target; remove deletes all credential assignments', async (t) => {
  const source =
    '# credentials\nGH_TOKEN=first\nexport GH_TOKEN="second"\nGITHUB_TOKEN=other\nFOGGY_SYNC_TOKEN=dedicated\nFOGGY_SYNC_REPO=o/r\nFOGGY_SYNC_BRANCH=main\nFOGGY_SYNC_PATH=state.json\nUNKNOWN=`a\nb`\n';
  const { home, path } = await fixture(t, source);
  let result = await run(home, ['setup'], defaults);
  assert.equal(result.code, 0, result.stderr);
  assert.ok((await readFile(path, 'utf8')).startsWith(source));
  result = await run(home, ['setup'], ['remove', 'remove', '', '', '', '', 'yes']);
  assert.equal(result.code, 0, result.stderr);
  const values = parse(await readFile(path, 'utf8'));
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'FOGGY_SYNC_TOKEN'])
    assert.equal(Object.hasOwn(values, key), false);
  assert.equal(values.UNKNOWN, 'a\nb');
  assert.equal(values.FOGGY_SYNC_REPO, 'o/r');
});

test('cancel, EOF and SIGINT leave config unchanged and release lock', async (t) => {
  for (const answers of [[...defaults.slice(0, -1), 'no'], ['EOF'], ['replace', 'SIGINT']]) {
    const { home, path, directory } = await fixture(t, 'UNKNOWN=unchanged\n');
    const result = await run(home, ['setup'], answers);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /Setup cancelled/);
    assert.equal(await readFile(path, 'utf8'), 'UNKNOWN=unchanged\n');
    assert.deepEqual(await readdir(directory), ['.env']);
  }
});

test('existing invalid sync configuration is validated without printing values or saving', async (t) => {
  const source = 'FOGGY_SYNC_TOKEN="bad secret"\n';
  const { home, path, directory } = await fixture(t, source);
  const result = await run(home, ['setup'], defaults);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /Configuration validation failed/);
  assert.doesNotMatch(result.stderr, /bad secret|ExperimentalWarning/);
  assert.equal(await readFile(path, 'utf8'), source);
  assert.deepEqual(await readdir(directory), ['.env']);
});

test('advanced legacy target editing uses server validation and data override removal deletes key', async (t) => {
  const { home, path } = await fixture(t, 'FOGGY_DATA_DIR=/old/location\n');
  const result = await run(
    home,
    ['setup'],
    ['', '', '', '', 'remove', 'yes', 'Owner/Repo', 'topic/branch', 'foggy/state.json', 'yes'],
  );
  assert.equal(result.code, 0, result.stderr);
  const values = parse(await readFile(path, 'utf8'));
  assert.equal(values.FOGGY_DATA_DIR, undefined);
  assert.equal(values.FOGGY_SYNC_REPO, 'Owner/Repo');
  assert.equal(values.FOGGY_SYNC_BRANCH, 'topic/branch');
  assert.match(result.stderr, /persisted cloud workspace targets are unaffected/);
});

test('polling seconds preserve exact milliseconds at fractional and upper boundaries', async (t) => {
  for (const [seconds, milliseconds] of [
    ['15.001', '15001'],
    ['2147483.647', '2147483647'],
  ]) {
    const { home, path } = await fixture(t);
    const result = await run(
      home,
      ['setup'],
      ['', '', '65536', '65535', '2147483.648', seconds, '', '', 'yes'],
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(parse(await readFile(path, 'utf8')).FOGGY_POLL_INTERVAL_MS, milliseconds);
  }
});

test('concurrent edit or symlink replacement refuses save without touching the other writer', async (t) => {
  for (const replace of [false, true]) {
    const { home, path, directory } = await fixture(t, 'OTHER=before\n');
    const hook = replace
      ? `writeFileSync(${JSON.stringify(path + '.other')}, 'OTHER=concurrent\\n'); unlinkSync(${JSON.stringify(path)}); symlinkSync(${JSON.stringify(path + '.other')}, ${JSON.stringify(path)});`
      : `writeFileSync(${JSON.stringify(path)}, 'OTHER=concurrent\\n');`;
    const result = await run(home, ['setup'], defaults, {}, hook);
    assert.equal(result.code, 1, result.stderr);
    assert.match(
      result.stderr,
      replace ? /symlink configuration/ : /Configuration changed during setup/,
    );
    assert.equal(await readFile(path, 'utf8'), 'OTHER=concurrent\n');
    assert.ok(
      !(await readdir(directory)).some(
        (name) => name.startsWith('.env.setup-') || name === '.setup.lock',
      ),
    );
  }
});

test('symlink config and existing setup locks are rejected conservatively', async (t) => {
  const { home, path, directory } = await fixture(t, 'OTHER=original\n');
  const target = join(home, 'target');
  await writeFile(target, 'GH_TOKEN=target-secret\n');
  await rm(path);
  await symlink(target, path);
  let result = await run(home, ['setup'], defaults);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /symlink configuration/);
  assert.equal(await readFile(target, 'utf8'), 'GH_TOKEN=target-secret\n');
  await mkdir(join(directory, '.setup.lock'));
  result = await run(home, ['setup'], defaults);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /never reclaimed automatically/);
  assert.ok((await lstat(join(directory, '.setup.lock'))).isDirectory());
});

test('dotenv encoding roundtrips supported punctuation, whitespace, escapes and multiline values', () => {
  for (const value of [
    '',
    'plain',
    ' a # b ',
    '"quoted"',
    "'quoted'",
    '`quoted`',
    'a\\nb\\rc',
    'a\nb\rc',
    'all\'"`quotes',
    'a\\"b',
    "a\\'b",
    '${NOT_EXPANDED}',
    'a=b # c',
    'snowman \u2603',
  ]) {
    assert.deepEqual(parse(`VALUE=${encodeSetupValue(value)}\n`), { VALUE: value });
  }
  assert.throws(
    () => encodeSetupValue('secret\0value'),
    /^Error: Unsupported configuration value\.$/,
  );
  assert.throws(() => encodeSetupValue('\ud800'), /Unsupported configuration value/);
  const source =
    '# top\nUNRELATED="line one\nline two" # retain\nexport GH_TOKEN="old\nsecret"\nGH_TOKEN=last\n';
  const values = parse(source);
  delete values.GH_TOKEN;
  assert.equal(
    updateSetupConfig(source, values),
    '# top\nUNRELATED="line one\nline two" # retain\n\n',
  );
});
