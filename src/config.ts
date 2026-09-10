import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { installRoot } from './install.js';
import { safeSyncRef } from './shared.js';

export interface ConfigKey {
  name: string;
  /** Wizard prompt. */
  label: string;
  secret: boolean;
  /** Shown by `foggy config list` when nothing supplies a value. */
  fallback?: (home: string) => string;
  validate: (value: string) => void;
}

function nonEmpty(name: string, value: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty.`);
  if (/[\r\n]/.test(value)) throw new Error(`${name} must be a single line.`);
}

function port(value: string): void {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535)
    throw new Error('FOGGY_PORT must be an integer between 1 and 65535.');
}

function pollInterval(value: string): void {
  const parsed = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(parsed) ||
    parsed < 15_000 ||
    parsed > 2_147_483_647
  )
    throw new Error('FOGGY_POLL_INTERVAL_MS must be an integer between 15000 and 2147483647.');
}

function syncRepo(value: string): void {
  if (
    !/^[a-z\d](?:[a-z\d-]*[a-z\d])?\/[a-z\d_.-]+$/i.test(value) ||
    ['.', '..'].includes(value.split('/')[1])
  )
    throw new Error('FOGGY_SYNC_REPO must be an OWNER/REPOSITORY pair.');
}

function syncRef(name: string): (value: string) => void {
  return (value) => {
    if (!safeSyncRef(value)) throw new Error(`${name} is not a safe sync reference.`);
  };
}

function serverOrigin(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('FOGGY_URL must be an absolute HTTP(S) server origin.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error(
      'FOGGY_URL must be an HTTP(S) origin without credentials, path, query, or fragment.',
    );
}

/** `FOGGY_HOME` is absent because it locates this file; `GITHUB_TOKEN` is still read as an alias
 * of `GH_TOKEN` but not offered twice; `FOGGY_VERSION` and `FOGGY_FORCE` belong to the installer. */
export const CONFIG_KEYS: ConfigKey[] = [
  {
    name: 'GH_TOKEN',
    label: 'GitHub token for pull request tracking',
    secret: true,
    validate: (value) => nonEmpty('GH_TOKEN', value),
  },
  {
    name: 'FOGGY_SYNC_TOKEN',
    label: 'Dedicated token for cloud workspace state sync',
    secret: true,
    validate: (value) => {
      nonEmpty('FOGGY_SYNC_TOKEN', value);
      if (!/^[\x21-\x7e]+$/.test(value))
        throw new Error('FOGGY_SYNC_TOKEN must contain only visible ASCII characters.');
    },
  },
  {
    name: 'FOGGY_SYNC_REPO',
    label: 'Private state repository (OWNER/REPOSITORY)',
    secret: false,
    validate: syncRepo,
  },
  {
    name: 'FOGGY_SYNC_BRANCH',
    label: 'State repository branch',
    secret: false,
    fallback: () => 'main',
    validate: syncRef('FOGGY_SYNC_BRANCH'),
  },
  {
    name: 'FOGGY_SYNC_PATH',
    label: 'State file path in the repository',
    secret: false,
    fallback: () => 'foggybrain/state.json',
    validate: syncRef('FOGGY_SYNC_PATH'),
  },
  {
    name: 'FOGGY_PORT',
    label: 'Server port',
    secret: false,
    fallback: () => '4173',
    validate: port,
  },
  {
    name: 'FOGGY_DATA_DIR',
    label: 'Server data directory',
    secret: false,
    fallback: (home) => join(home, '.local', 'share', 'foggybrain'),
    validate: (value) => nonEmpty('FOGGY_DATA_DIR', value),
  },
  {
    name: 'FOGGY_POLL_INTERVAL_MS',
    label: 'GitHub polling interval in milliseconds',
    secret: false,
    fallback: () => '60000',
    validate: pollInterval,
  },
  {
    name: 'FOGGY_URL',
    label: 'Server origin the CLI talks to',
    secret: false,
    fallback: () => 'http://127.0.0.1:4173',
    validate: serverOrigin,
  },
  {
    name: 'FOGGY_WORKSPACE',
    label: 'Default workspace ID',
    secret: false,
    validate: (value) => nonEmpty('FOGGY_WORKSPACE', value),
  },
];

const byName = new Map(CONFIG_KEYS.map((key) => [key.name, key]));

export function assertConfigKey(name: string): ConfigKey {
  const key = byName.get(name);
  if (!key) throw new Error(`${JSON.stringify(name)} is not a FoggyBrain configuration key.`);
  return key;
}

export function assertConfigValue(name: string, value: string): void {
  assertConfigKey(name).validate(value);
}

export function configFilePath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(installRoot(env, home), 'config.json');
}

export type ConfigValues = Record<string, string>;

export interface LoadedConfig {
  values: ConfigValues;
  /** One message per entry that had to be ignored, each naming the file. */
  problems: string[];
}

/** Never rejects over the file's contents, so one bad entry cannot lock a user out of the
 * command that would fix it. Callers that must not run on a half-understood file use
 * `readConfigFile` instead. */
export async function loadConfigFile(path = configFilePath()): Promise<LoadedConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { values: {}, problems: [] };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { values: {}, problems: [`${path} does not contain valid JSON.`] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return { values: {}, problems: [`${path} must contain a JSON object.`] };
  const values: ConfigValues = {};
  const problems: string[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    try {
      assertConfigKey(name);
      if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
      assertConfigValue(name, value);
      values[name] = value;
    } catch (error) {
      problems.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { values, problems };
}

export async function readConfigFile(path = configFilePath()): Promise<ConfigValues> {
  const { values, problems } = await loadConfigFile(path);
  if (problems.length > 0) throw new Error(problems[0]);
  return values;
}

export async function writeConfigFile(
  values: ConfigValues,
  path = configFilePath(),
): Promise<void> {
  for (const [name, value] of Object.entries(values)) assertConfigValue(name, value);
  const ordered: ConfigValues = {};
  for (const key of CONFIG_KEYS) if (key.name in values) ordered[key.name] = values[key.name];
  await mkdir(join(path, '..'), { recursive: true });
  // Written aside and renamed so a crash cannot leave a half-written file, and created 0600
  // from the start so a token is never briefly world-readable.
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(ordered, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export function applyConfigFile(env: NodeJS.ProcessEnv, values: ConfigValues): void {
  for (const [name, value] of Object.entries(values))
    if (env[name] === undefined) env[name] = value;
}

export function maskSecret(value: string): string {
  return value.length > 8 ? `****${value.slice(-4)}` : '****';
}

export type SettingSource =
  'environment' | 'config' | 'GITHUB_TOKEN' | 'gh auth token' | 'default' | 'unset';

export interface Setting {
  name: string;
  value: string | null;
  source: SettingSource;
}

export interface DescribeOptions {
  /** Whether `gh auth token` would supply a GitHub token. Pass a function to have it consulted
   * only when nothing else resolves `GH_TOKEN`, since the probe spawns a process. */
  ghToken: boolean | (() => boolean);
  home?: string;
  showSecrets?: boolean;
}

/** Call with the environment as the process sees it; a value matching the file is reported as
 * coming from the file, since `applyConfigFile` is what put it there. */
export function describeSettings(
  env: NodeJS.ProcessEnv,
  values: ConfigValues,
  options: DescribeOptions,
): Setting[] {
  const home = options.home ?? homedir();
  return CONFIG_KEYS.map((key) => {
    const show = (value: string) =>
      key.secret && !options.showSecrets ? maskSecret(value) : value;
    const setting = (value: string | null, source: SettingSource): Setting => ({
      name: key.name,
      value: value === null ? null : show(value),
      source,
    });
    // `readConfig` resolves the GitHub token as GH_TOKEN, then GITHUB_TOKEN, then the gh CLI,
    // treating a blank value as absent. Reporting anything else here would explain the wrong
    // credential for the exact cases this listing exists to explain.
    const live = key.name === 'GH_TOKEN' ? env.GH_TOKEN?.trim() || undefined : env[key.name];
    if (live !== undefined)
      return setting(live, values[key.name] === live ? 'config' : 'environment');
    if (key.name in values) return setting(values[key.name], 'config');
    if (key.name === 'GH_TOKEN') {
      const alias = env.GITHUB_TOKEN?.trim();
      if (alias) return setting(alias, 'GITHUB_TOKEN');
      const probe = options.ghToken;
      if (typeof probe === 'function' ? probe() : probe) return setting('****', 'gh auth token');
    }
    const fallback = key.fallback?.(home);
    return fallback === undefined ? setting(null, 'unset') : setting(fallback, 'default');
  });
}

export function readTokenFromGhCli(): string | undefined {
  try {
    return (
      execFileSync('gh', ['auth', 'token'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}
