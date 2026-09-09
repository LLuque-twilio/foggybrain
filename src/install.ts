import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirectory, readRunningPid, stopServer } from './daemon.js';

// The compiled CLI lives in dist/server/, the source in src/; package.json sits one level further up
// from the compiled tree.
const manifestUrl = new URL(
  import.meta.url.endsWith('.ts') ? '../package.json' : '../../package.json',
  import.meta.url,
);

export function packageVersion(): string {
  const manifest: unknown = JSON.parse(readFileSync(fileURLToPath(manifestUrl), 'utf8'));
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    !('version' in manifest) ||
    typeof manifest.version !== 'string'
  )
    throw new Error('package.json is missing a string version.');
  return manifest.version;
}

export const REPO = 'LLuque-twilio/foggybrain';
const PATH_MARKER = '# foggybrain';
const SYSTEM_PATHS_FILE = '/etc/paths.d/foggy';

export type Runner = (file: string, args: string[], input?: string) => Promise<void>;

export const execute: Runner = async (file, args, input) => {
  const child = execFile(file, args, { timeout: 120_000 });
  if (input !== undefined) child.stdin?.end(input);
  await new Promise<void>((done, fail) => {
    child.once('error', fail);
    child.once('close', (code) =>
      code === 0 ? done() : fail(new Error(`${file} exited with status ${code}.`)),
    );
  });
};

export function assertVersion(version: string): string {
  const normalized = version.startsWith('v') ? version.slice(1) : version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalized))
    throw new Error(`Invalid FoggyBrain version: ${JSON.stringify(version)}.`);
  return normalized;
}

export function installRoot(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.FOGGY_HOME !== undefined && !env.FOGGY_HOME.trim())
    throw new Error('FOGGY_HOME must not be empty.');
  return resolve(env.FOGGY_HOME ?? join(home, '.foggybrain'));
}

export function versionDirectory(version: string, root = installRoot()): string {
  return join(root, 'versions', assertVersion(version));
}

export function binDirectory(home = homedir()): string {
  return join(home, '.local', 'bin');
}

export async function currentVersion(root = installRoot()): Promise<string | null> {
  try {
    return assertVersion(
      await readlink(join(root, 'current')).then((target) => target.split('/').pop()!),
    );
  } catch {
    return null;
  }
}

export interface PathOptions {
  platform?: NodeJS.Platform;
  home?: string;
  binDir?: string;
  run?: Runner;
  pathsFile?: string;
}

export async function ensurePathEntry(options: PathOptions = {}): Promise<'created' | 'present'> {
  const home = options.home ?? homedir();
  const binDir = options.binDir ?? binDirectory(home);
  const run = options.run ?? execute;
  if ((options.platform ?? process.platform) === 'darwin') {
    // /etc/paths.d is read by every macOS shell, including the non-interactive ones agents spawn.
    const pathsFile = options.pathsFile ?? SYSTEM_PATHS_FILE;
    const existing = await readFile(pathsFile, 'utf8').catch(() => '');
    if (existing.trim() === binDir) return 'present';
    process.stderr.write(`Adding ${binDir} to the system PATH via ${pathsFile} (sudo required).\n`);
    await run('sudo', ['/usr/bin/tee', pathsFile], `${binDir}\n`);
    return 'created';
  }
  const profile = join(home, '.profile');
  const existing = await readFile(profile, 'utf8').catch(() => '');
  if (existing.includes(PATH_MARKER)) return 'present';
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  await writeFile(profile, `${existing}${separator}export PATH="${binDir}:$PATH" ${PATH_MARKER}\n`);
  return 'created';
}

export interface LinkOptions {
  version: string;
  root?: string;
  binDir?: string;
  home?: string;
  platform?: NodeJS.Platform;
  run?: Runner;
}

export interface LinkResult {
  version: string;
  path: string;
  bin: string;
  pathEntry: 'created' | 'present';
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function replaceSymlink(target: string, link: string): Promise<void> {
  await mkdir(dirname(link), { recursive: true });
  const staging = `${link}.tmp`;
  await rm(staging, { force: true });
  await symlink(target, staging);
  await rename(staging, link);
}

export async function linkVersion(options: LinkOptions): Promise<LinkResult> {
  const version = assertVersion(options.version);
  const home = options.home ?? homedir();
  const root = options.root ?? installRoot(process.env, home);
  const binDir = options.binDir ?? binDirectory(home);
  const path = versionDirectory(version, root);
  const executable = join(path, 'bin', 'foggy.mjs');
  await access(executable).catch(() => {
    throw new Error(`FoggyBrain ${version} is not installed at ${path}.`);
  });
  await replaceSymlink(path, join(root, 'current'));
  await replaceSymlink(join(root, 'current', 'bin', 'foggy.mjs'), join(binDir, 'foggy'));
  const pathEntry = await ensurePathEntry({
    platform: options.platform,
    home,
    binDir,
    run: options.run,
  });
  return { version, path, bin: join(binDir, 'foggy'), pathEntry };
}

const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

export function releaseAssetUrl(version: string): string {
  const normalized = assertVersion(version);
  return `https://github.com/${REPO}/releases/download/v${normalized}/foggybrain-${normalized}.tar.gz`;
}

export async function resolveLatestVersion(fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(LATEST_RELEASE_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'foggybrain-cli' },
    signal: AbortSignal.timeout(30_000),
  }).catch((error: unknown) => {
    throw new Error(
      `Cannot reach the FoggyBrain release list: ${error instanceof Error ? error.message : String(error)}.`,
    );
  });
  if (!response.ok)
    throw new Error(`Cannot read the latest FoggyBrain release (HTTP ${response.status}).`);
  const body: unknown = await response.json().catch(() => undefined);
  if (
    !body ||
    typeof body !== 'object' ||
    !('tag_name' in body) ||
    typeof body.tag_name !== 'string'
  )
    throw new Error('The latest FoggyBrain release has no tag name.');
  return assertVersion(body.tag_name);
}

export async function downloadVersion(
  version: string,
  options: { root?: string; fetchImpl?: typeof fetch; run?: Runner } = {},
): Promise<string> {
  const normalized = assertVersion(version);
  const root = options.root ?? installRoot();
  const url = releaseAssetUrl(normalized);
  const response = await (options.fetchImpl ?? fetch)(url, {
    headers: { 'User-Agent': 'foggybrain-cli' },
    signal: AbortSignal.timeout(300_000),
  }).catch((error: unknown) => {
    throw new Error(
      `Cannot download ${url}: ${error instanceof Error ? error.message : String(error)}.`,
    );
  });
  if (!response.ok)
    throw new Error(`Cannot download FoggyBrain ${normalized} (HTTP ${response.status}): ${url}`);
  const staging = join(root, 'tmp');
  await mkdir(staging, { recursive: true });
  const tarball = join(staging, `foggybrain-${normalized}.tar.gz`);
  await writeFile(tarball, Buffer.from(await response.arrayBuffer()));
  const target = versionDirectory(normalized, root);
  const partial = `${target}.partial`;
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial, { recursive: true });
  await (options.run ?? execute)('tar', ['-xzf', tarball, '-C', partial, '--strip-components=1']);
  await readFile(join(partial, 'dist', 'server', 'cli.js')).catch(() => {
    throw new Error(`The FoggyBrain ${normalized} archive is missing dist/server/cli.js.`);
  });
  await rm(target, { recursive: true, force: true });
  await rename(partial, target);
  await rm(tarball, { force: true });
  return target;
}

export interface UpgradeOptions extends Omit<LinkOptions, 'version'> {
  version?: string;
  fetchImpl?: typeof fetch;
}

export interface UpgradeResult extends LinkResult {
  previousVersion: string | null;
}

export async function upgrade(options: UpgradeOptions = {}): Promise<UpgradeResult> {
  const home = options.home ?? homedir();
  const root = options.root ?? installRoot(process.env, home);
  const version = options.version
    ? assertVersion(options.version)
    : await resolveLatestVersion(options.fetchImpl);
  const previousVersion = await currentVersion(root);
  await downloadVersion(version, { root, fetchImpl: options.fetchImpl, run: options.run });
  const linked = await linkVersion({ ...options, version, root, home });
  return { ...linked, previousVersion };
}

export async function removePathEntry(options: PathOptions = {}): Promise<'removed' | 'absent'> {
  const home = options.home ?? homedir();
  const binDir = options.binDir ?? binDirectory(home);
  const run = options.run ?? execute;
  if ((options.platform ?? process.platform) === 'darwin') {
    const pathsFile = options.pathsFile ?? SYSTEM_PATHS_FILE;
    const existing = await readFile(pathsFile, 'utf8').catch(() => null);
    if (existing === null) return 'absent';
    process.stderr.write(`Removing ${pathsFile} from the system PATH (sudo required).\n`);
    await run('sudo', ['/bin/rm', '-f', pathsFile]);
    return 'removed';
  }
  const profile = join(home, '.profile');
  const existing = await readFile(profile, 'utf8').catch(() => null);
  if (existing === null || !existing.includes(PATH_MARKER)) return 'absent';
  const kept = existing
    .split('\n')
    .filter((line) => !line.includes(PATH_MARKER))
    .join('\n');
  await writeFile(profile, kept);
  return 'removed';
}

export interface UninstallOptions extends PathOptions {
  root?: string;
  env?: NodeJS.ProcessEnv;
}

export interface UninstallResult {
  removed: string[];
  pathEntry: 'removed' | 'absent';
  keptDataDir: string;
}

export async function uninstall(options: UninstallOptions = {}): Promise<UninstallResult> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const root = options.root ?? installRoot(env, home);
  const binDir = options.binDir ?? binDirectory(home);
  const executable = join(binDir, 'foggy');
  const removed: string[] = [];

  // A pnpm-linked foggy points elsewhere; leave that install (and this root) alone entirely.
  const target = await readlink(executable).catch(() => null);
  const ownsExecutable =
    target === null || resolve(dirname(executable), target).startsWith(`${root}/`);
  if (!ownsExecutable) return { removed, pathEntry: 'absent', keptDataDir: dataDirectory(env) };

  if ((await readRunningPid(env)) !== null) await stopServer({ env });

  if (target !== null) {
    await rm(executable, { force: true });
    removed.push(executable);
  }
  const pathEntry = await removePathEntry({ ...options, home, binDir });
  if (await exists(root)) {
    await rm(root, { recursive: true, force: true });
    removed.push(root);
  }
  return { removed, pathEntry, keptDataDir: dataDirectory(env) };
}
