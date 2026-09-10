import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  readdir,
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
  force?: boolean;
}

export interface LinkResult {
  version: string;
  path: string;
  bin: string;
  pathEntry: 'created' | 'present' | 'failed';
}

// An executable that is not a symlink into the install root belongs to another installation --- a
// `pnpm link --global` shim, say. linkVersion refuses to replace one and uninstall refuses to
// delete one, so both need the same answer.
async function executableOwner(
  executable: string,
  root: string,
): Promise<{ owner: 'ours' | 'foreign' | 'absent'; target: string | null }> {
  const info = await lstat(executable).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (info === null) return { owner: 'absent', target: null };
  if (!info.isSymbolicLink()) return { owner: 'foreign', target: executable };
  const target = resolve(dirname(executable), await readlink(executable));
  return { owner: target.startsWith(`${root}/`) ? 'ours' : 'foreign', target };
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
  const executableLink = join(binDir, 'foggy');
  const { owner, target } = await executableOwner(executableLink, root);
  if (owner === 'foreign' && options.force !== true)
    throw new Error(
      `${executableLink} belongs to another FoggyBrain installation (${target}). Re-run with --force to replace it.`,
    );
  await replaceSymlink(path, join(root, 'current'));
  await replaceSymlink(join(root, 'current', 'bin', 'foggy.mjs'), executableLink);
  // The install is complete and usable once the symlinks are in place; a PATH entry that needs
  // sudo can fail without making that untrue, so report it rather than failing the command.
  const pathEntry = await ensurePathEntry({
    platform: options.platform,
    home,
    binDir,
    run: options.run,
  }).catch((error: unknown) => {
    // Only the macOS sudo branch can realistically fail, and macOS logs in through zsh, which
    // never reads ~/.profile.
    const profile = (options.platform ?? process.platform) === 'darwin' ? '.zprofile' : '.profile';
    process.stderr.write(
      `Could not add ${binDir} to your PATH: ${error instanceof Error ? error.message : String(error)}\n` +
        `FoggyBrain ${version} is installed and linked. Add it yourself with:\n` +
        `  echo 'export PATH="${binDir}:$PATH"' >> ~/${profile}\n`,
    );
    return 'failed' as const;
  });
  return { version, path, bin: executableLink, pathEntry };
}

const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

export function releaseAssetName(version: string): string {
  return `foggybrain-${assertVersion(version)}.tar.gz`;
}

export function releaseAssetUrl(version: string): string {
  const normalized = assertVersion(version);
  return `https://github.com/${REPO}/releases/download/v${normalized}/${releaseAssetName(normalized)}`;
}

export function releaseChecksumUrl(version: string): string {
  return `https://github.com/${REPO}/releases/download/v${assertVersion(version)}/SHA256SUMS`;
}

// SHA256SUMS lines are `<64 lowercase hex><two spaces><bare asset name>`, as `sha256sum` writes
// them; the `*` marks a binary-mode digest of the same bytes.
export function checksumFor(sums: string, asset: string): string | null {
  for (const line of sums.split('\n')) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trimEnd());
    if (match && match[2] === asset) return match[1]!;
  }
  return null;
}

async function download(url: string, what: string, fetchImpl: typeof fetch): Promise<Response> {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': 'foggybrain-cli' },
    signal: AbortSignal.timeout(300_000),
  }).catch((error: unknown) => {
    throw new Error(
      `Cannot download ${url}: ${error instanceof Error ? error.message : String(error)}.`,
    );
  });
  if (!response.ok) throw new Error(`Cannot download ${what} (HTTP ${response.status}): ${url}`);
  return response;
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
  const fetchImpl = options.fetchImpl ?? fetch;
  const asset = releaseAssetName(normalized);
  const sums = await (
    await download(
      releaseChecksumUrl(normalized),
      `the checksums for FoggyBrain ${normalized}`,
      fetchImpl,
    )
  ).text();
  const expected = checksumFor(sums, asset);
  if (expected === null)
    throw new Error(`The SHA256SUMS for FoggyBrain ${normalized} has no entry for ${asset}.`);
  const url = releaseAssetUrl(normalized);
  const response = await download(url, `FoggyBrain ${normalized}`, fetchImpl);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== expected)
    throw new Error(
      `Checksum mismatch for ${asset}: expected ${expected}, got ${digest}. Refusing to install ${url}.`,
    );
  const staging = join(root, 'tmp');
  await mkdir(staging, { recursive: true });
  const tarball = join(staging, asset);
  await writeFile(tarball, bytes);
  const target = versionDirectory(normalized, root);
  const partial = `${target}.partial`;
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial, { recursive: true });
  await (options.run ?? execute)('tar', ['-xzf', tarball, '-C', partial, '--strip-components=1']);
  // The same file linkVersion requires, so a bad archive fails here rather than at link time.
  await access(join(partial, 'bin', 'foggy.mjs')).catch(() => {
    throw new Error(`The FoggyBrain ${normalized} archive is missing bin/foggy.mjs.`);
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

// Read-only: whether a PATH entry exists, without touching it. Shared by removePathEntry and
// uninstall's no-op branch, which must report the real state rather than assume it was removed.
async function pathEntryState(options: PathOptions = {}): Promise<'present' | 'absent'> {
  const home = options.home ?? homedir();
  const binDir = options.binDir ?? binDirectory(home);
  if ((options.platform ?? process.platform) === 'darwin') {
    const pathsFile = options.pathsFile ?? SYSTEM_PATHS_FILE;
    const existing = await readFile(pathsFile, 'utf8').catch(() => '');
    return existing.trim() === binDir ? 'present' : 'absent';
  }
  const profile = join(home, '.profile');
  const existing = await readFile(profile, 'utf8').catch(() => null);
  return existing !== null && existing.includes(PATH_MARKER) ? 'present' : 'absent';
}

export async function removePathEntry(options: PathOptions = {}): Promise<'removed' | 'absent'> {
  const home = options.home ?? homedir();
  const binDir = options.binDir ?? binDirectory(home);
  const run = options.run ?? execute;
  if ((await pathEntryState({ ...options, home, binDir })) === 'absent') return 'absent';
  if ((options.platform ?? process.platform) === 'darwin') {
    const pathsFile = options.pathsFile ?? SYSTEM_PATHS_FILE;
    process.stderr.write(`Removing ${pathsFile} from the system PATH (sudo required).\n`);
    await run('sudo', ['/bin/rm', '-f', pathsFile]);
    return 'removed';
  }
  const profile = join(home, '.profile');
  const existing = await readFile(profile, 'utf8');
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
  pathEntry: 'removed' | 'absent' | 'present';
  keptDataDir: string;
  /** null when there was nothing to keep. */
  keptConfigFile: string | null;
}

export async function uninstall(options: UninstallOptions = {}): Promise<UninstallResult> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const root = options.root ?? installRoot(env, home);
  const binDir = options.binDir ?? binDirectory(home);
  const executable = join(binDir, 'foggy');
  const removed: string[] = [];

  const configFile = join(root, 'config.json');

  const { owner } = await executableOwner(executable, root);
  if (owner === 'foreign') {
    const pathEntry = await pathEntryState({ ...options, home, binDir });
    return { removed, pathEntry, keptDataDir: dataDirectory(env), keptConfigFile: null };
  }

  if ((await readRunningPid(env)) !== null) await stopServer({ env });

  if (owner === 'ours') {
    await rm(executable, { force: true });
    removed.push(executable);
  }
  const pathEntry = await removePathEntry({ ...options, home, binDir });
  // The user's tokens and settings survive an uninstall, the same way their task data does.
  // Only a missing file means there is nothing to keep: any other read failure would delete
  // credentials the caller was promised would be preserved, so it stops the uninstall instead.
  const config = await readFile(configFile).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  // Removing the root would only recreate it to hold the settings, so when that is all it
  // holds there is nothing left to remove and a repeated uninstall reports honestly.
  const contents = await readdir(root).catch(() => [] as string[]);
  const onlySettings = config !== null && contents.length === 1 && contents[0] === 'config.json';
  if ((await exists(root)) && !onlySettings) {
    await rm(root, { recursive: true, force: true });
    removed.push(root);
    if (config !== null) {
      await mkdir(root, { recursive: true });
      await writeFile(configFile, config, { mode: 0o600 });
    }
  }
  return {
    removed,
    pathEntry,
    keptDataDir: dataDirectory(env),
    keptConfigFile: config === null ? null : configFile,
  };
}
