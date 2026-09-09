import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
