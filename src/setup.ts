import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'dotenv';

const keys = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'FOGGY_SYNC_TOKEN',
  'FOGGY_PORT',
  'FOGGY_POLL_INTERVAL_MS',
  'FOGGY_DATA_DIR',
  'FOGGY_SYNC_REPO',
  'FOGGY_SYNC_BRANCH',
  'FOGGY_SYNC_PATH',
];

export function encodeSetupValue(value: string): string {
  if (value.includes('\0') || Buffer.from(value).toString() !== value)
    throw new Error('Unsupported configuration value.');
  const candidates = [
    value,
    `'${value}'`,
    `\`${value}\``,
    `"${value.replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`,
  ];
  for (const candidate of candidates) {
    if (isDeepStrictEqual(parse(`VALUE=${candidate}\n`), { VALUE: value })) return candidate;
  }
  throw new Error('Unsupported configuration value.');
}

export function updateSetupConfig(source: string, values: Record<string, string>): string {
  const previous = parse(source);
  const changed = new Set(keys.filter((key) => previous[key] !== values[key]));
  // Match dotenv's complete assignments, including multiline quoted values and duplicates.
  const assignment =
    /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;
  let result = source
    .replace(/\r\n?/g, '\n')
    .replace(assignment, (line, key: string) => (changed.has(key) ? '' : line));
  if (result && !result.endsWith('\n')) result += '\n';
  for (const key of changed) {
    if (values[key] !== undefined) result += `${key}=${encodeSetupValue(values[key])}\n`;
  }
  if (!isDeepStrictEqual(parse(result), values))
    throw new Error('Unsupported configuration syntax; file was not changed.');
  return result;
}

function validateConfig(values: Record<string, string>): void {
  // Reuse server validators without loading SQLite (and its warning) into the CLI process.
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const script = `
    import { readFileSync } from 'node:fs';
    import { parsePollInterval } from ${JSON.stringify(new URL(`./github.${extension}`, import.meta.url).href)};
    import { readSyncConfig } from ${JSON.stringify(new URL(`./sync.${extension}`, import.meta.url).href)};
    try {
      const env = JSON.parse(readFileSync(0, 'utf8'));
      parsePollInterval(env.FOGGY_POLL_INTERVAL_MS);
      readSyncConfig(env);
    } catch { process.exitCode = 1; }
  `;
  const result = spawnSync(
    process.execPath,
    [
      '--disable-warning=ExperimentalWarning',
      ...(extension === 'ts' ? ['--import', import.meta.resolve('tsx')] : []),
      '--input-type=module',
      '--eval',
      script,
    ],
    { input: JSON.stringify(values), encoding: 'utf8', timeout: 15_000 },
  );
  if (result.status !== 0)
    throw new Error(
      'Configuration validation failed. Check the polling interval, dedicated sync token, and legacy sync target. Nothing was saved.',
    );
}

export async function setup(): Promise<void> {
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new Error(
      'foggy setup requires an interactive terminal; noninteractive setup is not supported.',
    );
  const directory = join(homedir(), '.config', 'foggybrain');
  const path = join(directory, '.env');
  const lock = join(directory, '.setup.lock');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (await realpath(directory)) !== join(await realpath(homedir()), '.config', 'foggybrain')
  )
    throw new Error(
      'Setup requires a real configuration directory owned by the current user, without symlinks.',
    );
  await chmod(directory, 0o700);
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new Error(
      'Setup is locked. If a previous setup crashed, first verify no setup is running, then manually remove ~/.config/foggybrain/.setup.lock. Locks are never reclaimed automatically.',
    );
  }
  let temporary: string | undefined;
  const say = (text: string) => process.stderr.write(`${text}\n`);
  try {
    const snapshot = async () => {
      let file;
      try {
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new Error(
          'Cannot safely read configuration; symlink configuration files are not supported.',
        );
      }
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.uid !== process.getuid?.())
          throw new Error('Configuration must be a regular file owned by the current user.');
        const bytes = await file.readFile();
        if (!bytes.equals(Buffer.from(bytes.toString('utf8'))))
          throw new Error('Unsupported configuration encoding.');
        return {
          source: bytes.toString('utf8'),
          metadata: metadata(stat),
        };
      } finally {
        await file.close();
      }
    };
    const metadata = (stat: Awaited<ReturnType<typeof lstat>>) => ({
      ino: stat.ino,
      dev: stat.dev,
      mtime: stat.mtimeMs,
      ctime: stat.ctimeMs,
      mode: stat.mode,
      size: stat.size,
      uid: stat.uid,
    });
    const original = await snapshot();
    const values = { ...parse(original?.source ?? '') };
    const cancelled = new AbortController();
    const ask = async (prompt: string, secret = false): Promise<string> => {
      if (cancelled.signal.aborted || process.stdin.readableEnded || process.stdin.destroyed)
        throw new Error('Setup cancelled. Nothing was saved.');
      // Readline's kill ring survives historySize: 0. Never share editing state across questions.
      const output = new Writable({
        write(chunk, _encoding, callback) {
          if (!secret) process.stderr.write(chunk);
          callback();
        },
      });
      const terminal = createInterface({
        input: process.stdin,
        output,
        terminal: true,
        historySize: 0,
      });
      const cancel = () => cancelled.abort();
      terminal.once('close', cancel);
      terminal.once('SIGINT', cancel);
      if (secret) process.stderr.write(prompt);
      try {
        return await terminal.question(secret ? '' : prompt, { signal: cancelled.signal });
      } catch {
        throw new Error('Setup cancelled. Nothing was saved.');
      } finally {
        terminal.off('close', cancel);
        terminal.off('SIGINT', cancel);
        terminal.close();
        output.destroy();
        if (secret) say('');
      }
    };
    const choice = async (prompt: string, options: string[], fallback: string) => {
      for (;;) {
        const value =
          (await ask(`${prompt} [${options.join('/')}] (${fallback}): `)).trim().toLowerCase() ||
          fallback;
        if (options.includes(value)) return value;
        say('Invalid choice.');
      }
    };
    say(
      `Configuration: ${path}\nDefault data: ${join(homedir(), '.local', 'share', 'foggybrain')}\nLogs/runtime: ${join(homedir(), '.local', 'state', 'foggybrain')}`,
    );
    say(
      'Local configuration only. No network, server startup/stop, workspace writes, migration, or deletion. Enter keeps existing settings; Ctrl-C cancels.',
    );
    const overrides = keys.filter((key) => process.env[key] !== undefined);
    if (overrides.length)
      say(
        `Warning: process environment overrides saved settings: ${overrides.join(', ')}. Values are not copied into this file. GH_TOKEN takes precedence over GITHUB_TOKEN after environment merging.`,
      );
    say(
      'PR access: use a token with read-only Metadata and Pull requests for relevant repositories (Contents read and organization/SSO approval if required). Keep leaves GH_TOKEN/GITHUB_TOKEN unchanged; replacement writes GH_TOKEN and removes GITHUB_TOKEN. Without a token, the server may use gh auth token.',
    );
    for (const key of ['GH_TOKEN', 'FOGGY_SYNC_TOKEN']) {
      const present =
        key === 'GH_TOKEN' ? values.GH_TOKEN?.trim() || values.GITHUB_TOKEN?.trim() : values[key];
      if (key === 'FOGGY_SYNC_TOKEN')
        say(
          'Dedicated sync uses only FOGGY_SYNC_TOKEN, with Contents read/write on the selected private state repository. Removing it disables dedicated access, not workspace configuration.',
        );
      const action = await choice(
        `${key} (${present ? 'configured' : 'not configured'})`,
        ['keep', 'replace', 'remove'],
        'keep',
      );
      if (action === 'keep') continue;
      if (key === 'GH_TOKEN') delete values.GITHUB_TOKEN;
      delete values[key];
      if (action === 'replace') {
        for (;;) {
          const value = await ask(`${key} (hidden): `, true);
          if (!/^[\x21-\x7e]+$/.test(value)) {
            say('Invalid token: use nonempty visible ASCII characters without whitespace.');
            continue;
          }
          try {
            encodeSetupValue(value);
          } catch {
            say('Unsupported token encoding.');
            continue;
          }
          values[key] = value;
          break;
        }
      }
    }
    for (;;) {
      const value =
        (await ask('API port (Enter keeps existing, otherwise default 4173): ')).trim() ||
        values.FOGGY_PORT ||
        '4173';
      if (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535) {
        values.FOGGY_PORT = value;
        break;
      }
      say('Invalid port: enter an integer from 1 to 65535.');
    }
    for (;;) {
      const answer = (
        await ask('PR polling interval in seconds (Enter keeps existing, otherwise default 60): ')
      ).trim();
      const [seconds, fraction = ''] = answer.split('.');
      const value = answer
        ? String(Number(seconds) * 1000 + Number(fraction.padEnd(3, '0')))
        : (values.FOGGY_POLL_INTERVAL_MS ?? '60000');
      if (
        (!answer || /^\d+(?:\.\d{1,3})?$/.test(answer)) &&
        /^\d+$/.test(value) &&
        Number(value) >= 15000 &&
        Number(value) <= 2147483647
      ) {
        values.FOGGY_POLL_INTERVAL_MS = value;
        break;
      }
      say('Invalid interval: use 15 to 2147483.647 seconds, with at most three decimal places.');
    }
    say(
      'A data-directory override selects a different database; no data is moved, migrated, or deleted. Existing relative settings resolve against the configuration directory.',
    );
    const dataAction = await choice(
      'Data directory override',
      ['keep', 'replace', 'remove'],
      'keep',
    );
    if (dataAction === 'remove') delete values.FOGGY_DATA_DIR;
    if (dataAction === 'replace') {
      for (;;) {
        const value = await ask('Absolute data directory: ');
        if (isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value)) {
          values.FOGGY_DATA_DIR = value;
          break;
        }
        say('Invalid directory: enter an absolute path without control characters.');
      }
    }
    say(
      'Advanced legacy default sync target: persisted cloud workspace targets are unaffected. These settings can initialize/convert the original default workspace on startup. Prefer workspace create/connect for new cloud workspaces.',
    );
    if ((await choice('Edit legacy default sync target?', ['yes', 'no'], 'no')) === 'yes') {
      for (const [key, fallback] of [
        ['FOGGY_SYNC_REPO', ''],
        ['FOGGY_SYNC_BRANCH', 'main'],
        ['FOGGY_SYNC_PATH', 'foggybrain/state.json'],
      ]) {
        const answer = await ask(`${key} (Enter keeps existing/default; '-' removes): `);
        if (answer === '-') delete values[key];
        else if (answer) values[key] = answer;
        else if (values[key] === undefined && fallback) values[key] = fallback;
      }
    }
    if (values.FOGGY_DATA_DIR !== undefined && !values.FOGGY_DATA_DIR.trim())
      throw new Error('Invalid data directory. Nothing was saved.');
    validateConfig(values);
    const updated = updateSetupConfig(original?.source ?? '', values);
    say('Review saved configuration (secrets are never displayed):');
    for (const key of keys) {
      const status =
        values[key] === undefined
          ? 'not set'
          : key.endsWith('TOKEN')
            ? 'configured'
            : JSON.stringify(values[key]);
      const changed = parse(original?.source ?? '')[key] !== values[key];
      say(
        `  ${key}: ${status} (${changed ? (values[key] === undefined ? 'removed' : 'updated') : 'unchanged'})`,
      );
    }
    say(
      `Selected data: ${JSON.stringify(resolve(directory, values.FOGGY_DATA_DIR ?? join(homedir(), '.local', 'share', 'foggybrain')))}`,
    );
    if (
      (await ask('Save this configuration? Type yes to confirm: ')).trim().toLowerCase() !== 'yes'
    )
      throw new Error('Setup cancelled. Nothing was saved.');
    const currentDirectory = await lstat(directory);
    if (
      !currentDirectory.isDirectory() ||
      currentDirectory.ino !== info.ino ||
      currentDirectory.dev !== info.dev ||
      (currentDirectory.mode & 0o777) !== 0o700 ||
      (await realpath(directory)) !== join(await realpath(homedir()), '.config', 'foggybrain')
    )
      throw new Error('Configuration directory changed during setup. Nothing was saved.');
    temporary = join(directory, `.env.setup-${randomUUID()}`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(updated);
      await file.sync();
    } finally {
      await file.close();
    }
    if (!isDeepStrictEqual(await snapshot(), original))
      throw new Error(
        'Configuration changed during setup. Nothing was saved; rerun setup and review again.',
      );
    if (cancelled.signal.aborted) throw new Error('Setup cancelled. Nothing was saved.');
    const currentPath = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    // An open descriptor can still refer to an unlinked file after an editor's atomic save.
    if (!isDeepStrictEqual(currentPath ? metadata(currentPath) : null, original?.metadata ?? null))
      throw new Error(
        'Configuration changed during setup. Nothing was saved; rerun setup and review again.',
      );
    await rename(temporary, path);
    temporary = undefined;
    say('Configuration saved privately (0600). Nothing was started or stopped.');
    say(
      'Run foggy stop, then your next default API command or foggy dashboard starts with this configuration. Warning: stop is user-wide across registered APIs/built dashboards, ports, and data directories. It does not stop legacy unregistered servers, Vite, or watchers; stop those manually. Process environment still takes precedence.',
    );
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
    await rmdir(lock);
  }
}
