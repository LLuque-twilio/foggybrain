# End-User Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an end user install a working `foggy` CLI with one `curl | bash` command, then run `foggy start`, `foggy dashboard`, and `foggy upgrade` with no clone, no pnpm, and no manual `PATH` edits.

**Architecture:** A tagged release builds one `foggybrain-<version>.tar.gz` (built `dist/`, `bin/`, prod-only hoisted `node_modules/`, `package.json`) and publishes it as a GitHub Release asset. `scripts/install.sh` is a thin POSIX bootstrap: check Node, resolve the version, download, extract into `~/.foggybrain/versions/<version>/`, then hand off to the extracted CLI's own `foggy link` command. All install-layout logic (version validation, download, extraction, `current` symlink flip, `~/.local/bin/foggy` symlink, `PATH` wiring) lives in one testable TypeScript module, `src/install.ts`, shared by `foggy link` and `foggy upgrade`. Process lifecycle (`foggy start` / `stop`) is a separate module, `src/daemon.ts`, using a pidfile in the existing data directory.

**Tech Stack:** TypeScript (ESM, `type: module`), Node 22 (`node:test` via `tsx`), Commander 15, POSIX `sh`, system `tar` and `curl`, GitHub Actions, pnpm 10.14.0.

**Spec:** `docs/superpowers/specs/2026-09-09-end-user-distribution-design.md`

## Global Constraints

- Node floor: `>=22.13.0` (from `package.json` `engines`). The installer's version check and every error message use `22.13.0` verbatim.
- pnpm: `10.14.0`, pinned via `packageManager`. Use `pnpm install --frozen-lockfile` everywhere. Never create a competing lockfile.
- Repo slug: `LLuque-twilio/foggybrain`. Release asset name: `foggybrain-<version>.tar.gz`. Tag format: `v<version>`, matching `package.json` `version` exactly.
- Install layout: `~/.foggybrain/versions/<version>/`, `~/.foggybrain/current` (symlink), `~/.local/bin/foggy` (symlink to `~/.foggybrain/current/bin/foggy.mjs`). `FOGGY_HOME` overrides `~/.foggybrain` (used by tests and the smoke test).
- Data directory is untouched by this work: `FOGGY_DATA_DIR ?? ~/.local/share/foggybrain`. The pidfile is `foggy.pid` inside it.
- `PATH` wiring: write `/etc/paths.d/foggy` on macOS (via `sudo`), append a marked `export PATH` line to `~/.profile` on Linux. Never edit `~/.zshrc`, `~/.bashrc`, or any other shell rc file.
- Non-goals (do not implement): Windows support in `install.sh`, auto-installing Node, npm/Homebrew publishing, install telemetry, automatic pruning of old version directories.
- CLI output contract (unchanged, must be preserved by every new command): success is exactly one JSON value on stdout and exit `0`; failure is exactly one `{"error":"message"}` on stderr, empty stdout, exit `1`.
- Every task ends with `pnpm test && pnpm typecheck && pnpm build` green and `pnpm format` applied. Commit at the end of each task.
- No `any`. Follow the existing code's style: no comments that restate code; comment only non-obvious "why".

---

### Task 1: `foggy --version` and `ui` → `dashboard`

**Files:**
- Create: `src/install.ts` (only `packageVersion()` in this task)
- Modify: `src/cli.ts` (add `.version(...)`, rename the `ui` command to `dashboard`)
- Test: `src/cli.test.ts` (rename `ui` occurrences, add a `--version` assertion)
- Test: `src/install.test.ts` (new, `packageVersion()`)

**Interfaces:**
- Consumes: nothing.
- Produces: `packageVersion(): string` from `src/install.ts` — returns `package.json`'s `version` (e.g. `"0.1.0"`), resolved relative to the module's own location so it works from both `src/` (via tsx) and `dist/server/`. Task 3 and Task 4 reuse it.

- [ ] **Step 1: Write the failing test for `packageVersion()`**

Create `src/install.test.ts`:

```ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { packageVersion } from './install.js';

test('packageVersion reads the version from package.json', () => {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version: string };
  assert.equal(packageVersion(), manifest.version);
  assert.match(packageVersion(), /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --import tsx --test src/install.test.ts`
Expected: FAIL — `Cannot find module './install.js'`.

- [ ] **Step 3: Create `src/install.ts` with `packageVersion()`**

```ts
import { readFileSync } from 'node:fs';
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test src/install.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `--version` and rename `ui` in `src/cli.ts`**

Add the import next to the existing local imports:

```ts
import { packageVersion } from './install.js';
```

In `main()`, immediately after `.description('Manage a running Foggybrain server. No local fallback state.')`, add:

```ts
    .version(packageVersion(), '-v, --version', 'print the installed FoggyBrain version')
```

Then rename the command: change `program.command('ui')` to `program.command('dashboard')` and its description to `'Open the server UI in the default web browser'` (unchanged text). Do **not** keep an alias — `ui` is dropped outright.

- [ ] **Step 6: Update `src/cli.test.ts` for the rename and `--version`**

Replace the three `'ui'` arguments at `src/cli.test.ts:983`, `:987`, `:989` and the one at `:890` with `'dashboard'`. Then add this test at the end of the file:

```ts
test('CLI reports the installed version and rejects the removed ui command', async (t) => {
  const { run, requests } = await fixture(t);
  const version = await run(['--version']);
  assert.equal(version.code, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  const removed = await run(['ui']);
  assert.equal(removed.code, 1);
  assert.equal(removed.stdout, '');
  assert.equal(typeof JSON.parse(removed.stderr).error, 'string');
  assert.equal(requests.length, 0);
});
```

- [ ] **Step 7: Run the CLI tests**

Run: `node --import tsx --test src/cli.test.ts src/install.test.ts`
Expected: PASS.

- [ ] **Step 8: Update the docs that name `foggy ui`**

In `docs/cli.md`: change the `## UI` heading to `## Dashboard`, and replace every `foggy ui` in that section (lines around 355–365) with `foggy dashboard`, including `foggy --url http://127.0.0.1:5173 dashboard` and `foggy --workspace WORKSPACE_ID dashboard`.
In `README.md:30`: `foggy ui` → `foggy dashboard`.
In `docs/local-guide.md:52` and `:59`: `foggy ui` → `foggy dashboard`, and `pnpm foggy --url http://127.0.0.1:5173 ui` → `pnpm foggy --url http://127.0.0.1:5173 dashboard`.
In `AGENTS.md`: `foggy --workspace ID ui` → `foggy --workspace ID dashboard`.

- [ ] **Step 9: Verify all checks**

Run: `pnpm format && pnpm test && pnpm typecheck && pnpm build`
Expected: all pass. Then `grep -rn "foggy ui" README.md AGENTS.md docs src` returns nothing.

- [ ] **Step 10: Commit**

```bash
git add src/install.ts src/install.test.ts src/cli.ts src/cli.test.ts README.md AGENTS.md docs/cli.md docs/local-guide.md
git commit -m "feat: add foggy --version and rename ui to dashboard"
```

---

### Task 2: `foggy start` and `foggy stop`

**Files:**
- Create: `src/daemon.ts`
- Create: `src/daemon.test.ts`
- Modify: `src/cli.ts` (register `start` and `stop`)
- Modify: `docs/cli.md`, `README.md`, `AGENTS.md`, `docs/local-guide.md`, `src/web/App.tsx:123`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces, from `src/daemon.ts`:
  - `dataDirectory(env?: NodeJS.ProcessEnv): string`
  - `pidFilePath(env?: NodeJS.ProcessEnv): string`
  - `serverOrigin(env?: NodeJS.ProcessEnv): string`
  - `serverEntry(): { command: string; args: string[] }`
  - `readRunningPid(env?: NodeJS.ProcessEnv): Promise<number | null>`
  - `startServer(options?: { env?: NodeJS.ProcessEnv; spawnImpl?: typeof spawn }): Promise<{ pid: number; url: string; dataDir: string }>`
  - `stopServer(options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<{ stopped: boolean; pid: number | null }>`

- [ ] **Step 1: Write the failing unit tests**

Create `src/daemon.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  dataDirectory,
  pidFilePath,
  readRunningPid,
  serverOrigin,
  startServer,
  stopServer,
} from './daemon.js';

const scratch = () => mkdtemp(join(tmpdir(), 'foggy-daemon-'));

test('dataDirectory, pidFilePath, and serverOrigin follow the server environment', () => {
  assert.equal(dataDirectory({ FOGGY_DATA_DIR: '/tmp/foggy-data' }), '/tmp/foggy-data');
  assert.equal(pidFilePath({ FOGGY_DATA_DIR: '/tmp/foggy-data' }), '/tmp/foggy-data/foggy.pid');
  assert.match(dataDirectory({}), /\.local\/share\/foggybrain$/);
  assert.equal(serverOrigin({}), 'http://127.0.0.1:4173');
  assert.equal(serverOrigin({ FOGGY_PORT: '4189' }), 'http://127.0.0.1:4189');
  assert.throws(() => dataDirectory({ FOGGY_DATA_DIR: ' ' }), /must not be empty/);
  assert.throws(() => serverOrigin({ FOGGY_PORT: '0' }), /FOGGY_PORT/);
});

test('startServer writes a pidfile, unrefs the child, and refuses a second server', async () => {
  const dir = await scratch();
  const env = { FOGGY_DATA_DIR: dir, FOGGY_PORT: '4321' };
  let unrefs = 0;
  const spawnImpl = ((command: string, args: string[], options: Record<string, unknown>) => {
    assert.equal(command, process.execPath);
    assert.ok(args.at(-1)?.includes('server'));
    assert.equal(options.detached, true);
    assert.equal(options.stdio, 'ignore');
    return {
      pid: process.pid,
      unref: () => {
        unrefs++;
      },
    };
  }) as never;
  const started = await startServer({ env, spawnImpl });
  assert.equal(started.pid, process.pid);
  assert.equal(started.url, 'http://127.0.0.1:4321');
  assert.equal(unrefs, 1);
  assert.equal((await readFile(join(dir, 'foggy.pid'), 'utf8')).trim(), String(process.pid));
  assert.equal(await readRunningPid(env), process.pid);
  await assert.rejects(() => startServer({ env, spawnImpl }), /already running/);
});

test('a stale or malformed pidfile does not block a start and reports a clean stop', async () => {
  const dir = await scratch();
  const env = { FOGGY_DATA_DIR: dir };
  await writeFile(join(dir, 'foggy.pid'), 'not-a-pid\n');
  assert.equal(await readRunningPid(env), null);
  assert.deepEqual(await stopServer({ env }), { stopped: false, pid: null });
  assert.equal(await readRunningPid(env), null);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --import tsx --test src/daemon.test.ts`
Expected: FAIL — `Cannot find module './daemon.js'`.

- [ ] **Step 3: Create `src/daemon.ts`**

```ts
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export function dataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FOGGY_DATA_DIR !== undefined && !env.FOGGY_DATA_DIR.trim())
    throw new Error('FOGGY_DATA_DIR must not be empty.');
  return resolve(env.FOGGY_DATA_DIR ?? join(homedir(), '.local', 'share', 'foggybrain'));
}

export function pidFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDirectory(env), 'foggy.pid');
}

export function serverOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.FOGGY_PORT ?? '4173';
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('FOGGY_PORT must be an integer between 1 and 65535.');
  return `http://127.0.0.1:${port}`;
}

export function serverEntry(): { command: string; args: string[] } {
  const source = import.meta.url.endsWith('.ts');
  const entry = fileURLToPath(new URL(source ? './server.ts' : './server.js', import.meta.url));
  // A source checkout has no compiled server to spawn, so run it through tsx.
  return { command: process.execPath, args: source ? ['--import', 'tsx', entry] : [entry] };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function readRunningPid(env: NodeJS.ProcessEnv = process.env): Promise<number | null> {
  let text: string;
  try {
    text = await readFile(pidFilePath(env), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const pid = Number(trimmed);
  return pid > 0 && alive(pid) ? pid : null;
}

export async function startServer(
  options: { env?: NodeJS.ProcessEnv; spawnImpl?: typeof spawn } = {},
): Promise<{ pid: number; url: string; dataDir: string }> {
  const env = options.env ?? process.env;
  const running = await readRunningPid(env);
  if (running !== null)
    throw new Error(`Foggybrain is already running (pid ${running}). Run foggy stop first.`);
  const dataDir = dataDirectory(env);
  const url = serverOrigin(env);
  await mkdir(dataDir, { recursive: true });
  const { command, args } = serverEntry();
  const child = (options.spawnImpl ?? spawn)(command, args, {
    detached: true,
    stdio: 'ignore',
    env,
  });
  if (typeof child.pid !== 'number')
    throw new Error('Could not start the Foggybrain server: no child process ID.');
  child.unref();
  await writeFile(pidFilePath(env), `${child.pid}\n`);
  return { pid: child.pid, url, dataDir };
}

export async function stopServer(
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ stopped: boolean; pid: number | null }> {
  const env = options.env ?? process.env;
  const pid = await readRunningPid(env);
  const remove = () => rm(pidFilePath(env), { force: true });
  if (pid === null) {
    await remove();
    return { stopped: false, pid: null };
  }
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  while (alive(pid) && Date.now() < deadline) await delay(100);
  if (alive(pid))
    throw new Error(`Foggybrain (pid ${pid}) did not exit after SIGTERM. Inspect it before retrying.`);
  await remove();
  return { stopped: true, pid };
}
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `node --import tsx --test src/daemon.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the real start/stop round-trip test**

Append to `src/daemon.test.ts`:

```ts
test('a started server answers the API and stops on request', async () => {
  const dir = await scratch();
  const env = {
    ...process.env,
    FOGGY_DATA_DIR: dir,
    FOGGY_PORT: '4356',
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
  };
  const started = await startServer({ env });
  try {
    let snapshot: Response | undefined;
    for (let attempt = 0; attempt < 100 && !snapshot?.ok; attempt++) {
      snapshot = await fetch(`${started.url}/api/state`).catch(() => undefined);
      if (!snapshot?.ok) await new Promise((done) => setTimeout(done, 100));
    }
    assert.equal(snapshot?.ok, true);
  } finally {
    assert.deepEqual(await stopServer({ env }), { stopped: true, pid: started.pid });
  }
  assert.equal(await readRunningPid(env), null);
});
```

- [ ] **Step 6: Run it and verify it passes**

Run: `node --import tsx --test src/daemon.test.ts`
Expected: PASS (4 tests). If the port is occupied on the machine, change `4356` to another free port rather than reusing `4173` or the e2e port `4189`.

- [ ] **Step 7: Register the commands in `src/cli.ts`**

Add the import:

```ts
import { startServer, stopServer } from './daemon.js';
```

Insert immediately before the `dashboard` command registration:

```ts
  program
    .command('start')
    .description('Start the Foggybrain server in the background')
    .action(async () => output(await startServer()));
  program
    .command('stop')
    .description('Stop the background Foggybrain server')
    .action(async () => output(await stopServer()));
```

- [ ] **Step 8: Add a CLI-level test for the new commands**

Append to `src/cli.test.ts`:

```ts
test('CLI stop reports cleanly with no running server and makes no API calls', async (t) => {
  const { run, requests } = await fixture(t);
  const dir = await mkdtemp(join(tmpdir(), 'foggy-cli-stop-'));
  const result = await run(['--json', 'stop'], { FOGGY_DATA_DIR: dir });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { stopped: false, pid: null });
  assert.equal(requests.length, 0);
});
```

Add the imports it needs at the top of `src/cli.test.ts`: `import { mkdtemp } from 'node:fs/promises';`, `import { tmpdir } from 'node:os';`, `import { join } from 'node:path';`.

- [ ] **Step 9: Run the CLI tests**

Run: `node --import tsx --test src/cli.test.ts src/daemon.test.ts`
Expected: PASS.

- [ ] **Step 10: Document the commands**

In `docs/cli.md`, add a `## Server Lifecycle` section directly above `## Dashboard`:

````markdown
## Server Lifecycle

```text
foggy start
foggy stop
```

`foggy start` spawns the server detached, writes its process ID to `foggy.pid` in the data directory (`FOGGY_DATA_DIR`, default `~/.local/share/foggybrain`), and returns `{"pid":12345,"url":"http://127.0.0.1:4173","dataDir":"..."}`. Server output is discarded. Starting twice is an error while the recorded process is alive; a stale pidfile is ignored. `FOGGY_PORT` selects the port; `--url` / `FOGGY_URL` do not, since they configure the client, not the server.

`foggy stop` sends `SIGTERM` to the recorded process, waits up to five seconds for it to exit, and removes the pidfile. With no server recorded it returns `{"stopped":false,"pid":null}` and exit `0`.
````

Also update the file's opening paragraph (`docs/cli.md:3`): replace "It does not start the server, poll GitHub itself, or maintain fallback local state. Run `pnpm dev` for development, or `pnpm build && pnpm start` for the built app." with "It does not poll GitHub itself or maintain fallback local state. Start a server with `foggy start`, or `pnpm dev` for development."

In `README.md`, add `foggy start` above `foggy dashboard` in the command list and change line 16's "Leave the server running; `foggy` does not start it automatically." to "Leave the server running, or start it in the background with `foggy start`."
In `AGENTS.md:25`, append to that paragraph: "`foggy start` runs the built server detached and `foggy stop` stops it; both use the pidfile in `FOGGY_DATA_DIR`."
In `src/web/App.tsx:123`, change the message to `'Cannot reach the local server. Keep foggy start, pnpm dev, or pnpm start running; your last loaded graph is shown.'`

- [ ] **Step 11: Verify all checks**

Run: `pnpm format && pnpm test && pnpm typecheck && pnpm build`
Expected: all pass. `pnpm test:e2e` is not required — no route or DTO changed.

- [ ] **Step 12: Commit**

```bash
git add src/daemon.ts src/daemon.test.ts src/cli.ts src/cli.test.ts src/web/App.tsx README.md AGENTS.md docs/cli.md
git commit -m "feat: add foggy start and foggy stop"
```

---

### Task 3: Install layout and `foggy link`

**Files:**
- Modify: `src/install.ts` (add the layout, linking, and `PATH` logic)
- Modify: `src/install.test.ts`
- Modify: `src/cli.ts` (register `link`)
- Test: `src/cli.test.ts` (error path for an unknown version)

**Interfaces:**
- Consumes: `packageVersion()` from Task 1.
- Produces, from `src/install.ts`:
  - `REPO = 'LLuque-twilio/foggybrain'`
  - `assertVersion(version: string): string` — strips one leading `v`, validates `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`, returns the normalized version; throws otherwise.
  - `installRoot(env?: NodeJS.ProcessEnv, home?: string): string`
  - `versionDirectory(version: string, root?: string): string`
  - `binDirectory(home?: string): string`
  - `currentVersion(root?: string): Promise<string | null>`
  - `ensurePathEntry(options?: PathOptions): Promise<'created' | 'present'>`
  - `linkVersion(options: LinkOptions): Promise<LinkResult>`
  - `type Runner = (file: string, args: string[], input?: string) => Promise<void>`
  - `interface LinkOptions { version: string; root?: string; binDir?: string; home?: string; platform?: NodeJS.Platform; run?: Runner }`
  - `interface LinkResult { version: string; path: string; bin: string; pathEntry: 'created' | 'present' }`
- Task 4 reuses `assertVersion`, `installRoot`, `versionDirectory`, `linkVersion`, `currentVersion`, and `Runner`.

- [ ] **Step 1: Write the failing tests**

Append to `src/install.test.ts`:
(Merge these imports into the file's existing import statements rather than duplicating `assert`, `test`, or `node:fs/promises` imports; drop any import a test does not use.)

```ts
import { mkdir, mkdtemp, readFile, readlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertVersion,
  binDirectory,
  currentVersion,
  ensurePathEntry,
  installRoot,
  linkVersion,
  versionDirectory,
} from './install.js';

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

  const second = await linkVersion({ version: 'v0.2.0', root, binDir, home, platform: 'linux', run });
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
    () => linkVersion({ version: '9.9.9', root, binDir: join(root, 'bin'), home: root, platform: 'linux', run: async () => {} }),
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
  assert.equal(await ensurePathEntry({ platform: 'darwin', home, binDir, run, pathsFile }), 'present');
  assert.equal(calls.length, 1);
});
```

Note: `PathOptions` therefore includes an overridable `pathsFile` so the macOS branch is testable without touching `/etc`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --import tsx --test src/install.test.ts`
Expected: FAIL — `assertVersion` and the other exports do not exist.

- [ ] **Step 3: Implement the layout and linking in `src/install.ts`**

Add to `src/install.ts` (keeping `packageVersion()` from Task 1):

```ts
import { execFile } from 'node:child_process';
import { mkdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

export const REPO = 'LLuque-twilio/foggybrain';
const PATH_MARKER = '# foggybrain';
const SYSTEM_PATHS_FILE = '/etc/paths.d/foggy';

export type Runner = (file: string, args: string[], input?: string) => Promise<void>;

const execute: Runner = async (file, args, input) => {
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
    return assertVersion(await readlink(join(root, 'current')).then((target) => target.split('/').pop()!));
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

export async function ensurePathEntry(
  options: PathOptions = {},
): Promise<'created' | 'present'> {
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
  await readFile(executable).catch(() => {
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test src/install.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Register `foggy link` in `src/cli.ts`**

Add to the import from `./install.js`: `linkVersion`. Then insert before the `start` command:

```ts
  program
    .command('link')
    .description('Point the foggy executable and current version at an installed version')
    .option('--version <version>', 'installed version (default: this CLI version)')
    .action(async (options) => output(await linkVersion({ version: options.version ?? packageVersion() })));
```

- [ ] **Step 6: Add a CLI-level test for the error path**

Append to `src/cli.test.ts`:

```ts
test('CLI link fails clearly for a version that is not installed', async (t) => {
  const { run, requests } = await fixture(t);
  const root = await mkdtemp(join(tmpdir(), 'foggy-cli-link-'));
  const result = await run(['--json', 'link', '--version', '9.9.9'], { FOGGY_HOME: root });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(JSON.parse(result.stderr).error, /not installed/);
  assert.equal(requests.length, 0);
});
```

- [ ] **Step 7: Run the tests**

Run: `node --import tsx --test src/cli.test.ts src/install.test.ts`
Expected: PASS.

- [ ] **Step 8: Verify all checks**

Run: `pnpm format && pnpm test && pnpm typecheck && pnpm build`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/install.ts src/install.test.ts src/cli.ts src/cli.test.ts
git commit -m "feat: add install layout and foggy link"
```

---

### Task 4: `foggy upgrade`

**Files:**
- Modify: `src/install.ts` (add version resolution, download, extraction, `upgrade`)
- Modify: `src/install.test.ts`
- Modify: `src/cli.ts` (register `upgrade`)
- Modify: `docs/cli.md`

**Interfaces:**
- Consumes: `assertVersion`, `installRoot`, `versionDirectory`, `linkVersion`, `currentVersion`, `Runner`, `REPO` from Task 3.
- Produces, from `src/install.ts`:
  - `releaseAssetUrl(version: string): string`
  - `resolveLatestVersion(fetchImpl?: typeof fetch): Promise<string>`
  - `downloadVersion(version: string, options?: { root?: string; fetchImpl?: typeof fetch; run?: Runner }): Promise<string>`
  - `upgrade(options?: UpgradeOptions): Promise<UpgradeResult>` where `interface UpgradeOptions extends LinkOptions-without-version { version?: string; fetchImpl?: typeof fetch }` and `interface UpgradeResult extends LinkResult { previousVersion: string | null }`

- [ ] **Step 1: Write the failing tests**

Append to `src/install.test.ts`:
(Merge these imports into the file's existing import statements rather than duplicating `assert`, `test`, or `node:fs/promises` imports; drop any import a test does not use.)

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { downloadVersion, releaseAssetUrl, resolveLatestVersion, upgrade } from './install.js';

async function archive(version: string): Promise<Buffer> {
  const stage = await scratch();
  const top = join(stage, `foggybrain-${version}`);
  await mkdir(join(top, 'bin'), { recursive: true });
  await mkdir(join(top, 'dist', 'server'), { recursive: true });
  await writeFile(join(top, 'bin', 'foggy.mjs'), '#!/usr/bin/env node\n', { mode: 0o755 });
  await writeFile(join(top, 'dist', 'server', 'cli.js'), `export const version = '${version}';\n`);
  await writeFile(join(top, 'package.json'), JSON.stringify({ version }));
  await promisify(execFile)('tar', ['-czf', join(stage, 'a.tar.gz'), '-C', stage, `foggybrain-${version}`]);
  return readFile(join(stage, 'a.tar.gz'));
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
  const bytes = await archive('0.3.0');
  const fetchImpl = (async (input: string) => {
    if (String(input).endsWith('/releases/latest'))
      return new Response(JSON.stringify({ tag_name: 'v0.3.0' }), { status: 200 });
    assert.equal(String(input), releaseAssetUrl('0.3.0'));
    return new Response(bytes, { status: 200 });
  }) as unknown as typeof fetch;
  const first = await upgrade({ root, home, binDir, platform: 'linux', fetchImpl });
  assert.equal(first.version, '0.3.0');
  assert.equal(first.previousVersion, null);
  assert.equal(await currentVersion(root), '0.3.0');
  assert.equal(
    await readFile(join(versionDirectory('0.3.0', root), 'dist', 'server', 'cli.js'), 'utf8'),
    "export const version = '0.3.0';\n",
  );

  // Re-running the same version is safe and keeps the old directory in place for rollback.
  const again = await upgrade({ version: 'v0.3.0', root, home, binDir, platform: 'linux', fetchImpl });
  assert.equal(again.previousVersion, '0.3.0');
  assert.equal(await currentVersion(root), '0.3.0');
});

test('downloadVersion rejects an archive without a compiled CLI', async () => {
  const root = await scratch();
  const stage = await scratch();
  await mkdir(join(stage, 'foggybrain-0.5.0'), { recursive: true });
  await writeFile(join(stage, 'foggybrain-0.5.0', 'README'), 'x');
  await promisify(execFile)('tar', ['-czf', join(stage, 'a.tar.gz'), '-C', stage, 'foggybrain-0.5.0']);
  const bytes = await readFile(join(stage, 'a.tar.gz'));
  const fetchImpl = (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(() => downloadVersion('0.5.0', { root, fetchImpl }), /archive/i);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --import tsx --test src/install.test.ts`
Expected: FAIL — `releaseAssetUrl` and friends do not exist.

- [ ] **Step 3: Implement download and upgrade in `src/install.ts`**

Append:

```ts
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
  if (!body || typeof body !== 'object' || !('tag_name' in body) || typeof body.tag_name !== 'string')
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test src/install.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Register `foggy upgrade` in `src/cli.ts`**

Add `upgrade` to the `./install.js` import, then insert directly after the `link` command:

```ts
  program
    .command('upgrade')
    .description('Download a FoggyBrain release and switch this installation to it')
    .option('--version <version>', 'release version (default: latest)')
    .action(async (options) => output(await upgrade({ version: options.version })));
```

- [ ] **Step 6: Add a CLI-level test for the invalid-version error path**

Append to `src/cli.test.ts`:

```ts
test('CLI upgrade rejects a malformed version without any network access', async (t) => {
  const { run, requests } = await fixture(t);
  const root = await mkdtemp(join(tmpdir(), 'foggy-cli-upgrade-'));
  const result = await run(['--json', 'upgrade', '--version', '../evil'], { FOGGY_HOME: root });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(JSON.parse(result.stderr).error, /Invalid FoggyBrain version/);
  assert.equal(requests.length, 0);
});
```

- [ ] **Step 7: Run the tests**

Run: `node --import tsx --test src/cli.test.ts src/install.test.ts`
Expected: PASS.

- [ ] **Step 8: Document `link` and `upgrade` in `docs/cli.md`**

Add a `## Installation And Upgrades` section directly above `## Server Lifecycle`:

````markdown
## Installation And Upgrades

```text
foggy upgrade [--version <version>]
foggy link [--version <version>]
```

These commands manage a curl-installed FoggyBrain under `~/.foggybrain` (override with `FOGGY_HOME`). They are not used by a `pnpm link --global` development install.

`foggy upgrade` resolves the latest GitHub release (or `--version`), downloads `foggybrain-<version>.tar.gz`, extracts it to `~/.foggybrain/versions/<version>/`, repoints `~/.foggybrain/current` and `~/.local/bin/foggy`, and returns `{"version":"...","path":"...","bin":"...","pathEntry":"present","previousVersion":"..."}`. Old version directories are kept for rollback; remove them with `rm -rf ~/.foggybrain/versions/<old>`.

`foggy link` performs only the symlink and `PATH` steps for an already-extracted version, defaulting to the running CLI's own version. Use it to roll back: `~/.foggybrain/versions/<old>/bin/foggy.mjs link`. `pathEntry` is `created` when the `PATH` entry had to be written (`/etc/paths.d/foggy` on macOS, which prompts for `sudo`; a marked line in `~/.profile` on Linux) and `present` when it was already correct.
````

- [ ] **Step 9: Verify all checks**

Run: `pnpm format && pnpm test && pnpm typecheck && pnpm build`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add src/install.ts src/install.test.ts src/cli.ts src/cli.test.ts docs/cli.md
git commit -m "feat: add foggy upgrade"
```

---

### Task 5: `foggy uninstall`

**Files:**
- Modify: `src/install.ts` (add `removePathEntry` and `uninstall`)
- Modify: `src/install.test.ts`
- Modify: `src/cli.ts` (register `uninstall`)
- Modify: `docs/cli.md`

**Interfaces:**
- Consumes: `installRoot`, `binDirectory`, `versionDirectory`, `PathOptions`, `Runner` from Task 3; `dataDirectory` and `stopServer` from Task 2.
- Produces, from `src/install.ts`:
  - `removePathEntry(options?: PathOptions): Promise<'removed' | 'absent'>`
  - `uninstall(options?: UninstallOptions): Promise<UninstallResult>` where
    `interface UninstallOptions { root?: string; binDir?: string; home?: string; platform?: NodeJS.Platform; run?: Runner; pathsFile?: string; env?: NodeJS.ProcessEnv }` and
    `interface UninstallResult { removed: string[]; pathEntry: 'removed' | 'absent'; keptDataDir: string }`

- [ ] **Step 1: Write the failing tests**

Append to `src/install.test.ts` (merge imports into the existing statements; add `import { readdir, stat } from 'node:fs/promises';` and `import { removePathEntry, uninstall } from './install.js';` contents into the existing imports):

```ts
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
  assert.equal(await removePathEntry({ platform: 'darwin', home, binDir, run, pathsFile }), 'removed');
  assert.deepEqual(calls, [['sudo', '/bin/rm', '-f', pathsFile]]);
  assert.equal(await removePathEntry({ platform: 'darwin', home, binDir, run, pathsFile }), 'absent');
  assert.equal(calls.length, 1);

  const profile = join(home, '.profile');
  await writeFile(profile, `# mine\nexport EDITOR=vi\nexport PATH="${binDir}:$PATH" # foggybrain\nexport LANG=C\n`);
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

  const repeat = await uninstall({ root, binDir, home, platform: 'linux', env: { FOGGY_DATA_DIR: dataDir } });
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
  const result = await uninstall({ root, binDir, home, platform: 'linux', env: { FOGGY_DATA_DIR: other } });
  assert.deepEqual(result.removed, []);
  assert.equal(await readlink(join(binDir, 'foggy')), join(other, 'foggy.mjs'));
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --import tsx --test src/install.test.ts`
Expected: FAIL — `removePathEntry` and `uninstall` are not exported.

- [ ] **Step 3: Implement `removePathEntry` and `uninstall` in `src/install.ts`**

Append (and add `import { dataDirectory, readRunningPid, stopServer } from './daemon.js';` to the imports):

```ts
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

  if ((await readRunningPid(env)) !== null) await stopServer({ env });

  // Only reclaim an executable this installer owns; a pnpm-linked foggy points elsewhere.
  const target = await readlink(executable).catch(() => null);
  if (target !== null && resolve(dirname(executable), target).startsWith(`${root}/`)) {
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
```

`uninstall` uses this helper, which belongs next to `replaceSymlink`:

```ts
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
```

Add `stat` to the `node:fs/promises` import and `dirname` to the `node:path` import.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test src/install.test.ts`
Expected: PASS (all install tests, including the three new ones).

- [ ] **Step 5: Register `foggy uninstall` in `src/cli.ts`**

Add `binDirectory`, `installRoot`, and `uninstall` to the `./install.js` import and `dataDirectory` to the `./daemon.js` import. Then insert directly after the `upgrade` command:

```ts
  program
    .command('uninstall')
    .description('Remove the installed foggy executable, its PATH entry, and ~/.foggybrain')
    .option('--yes', 'explicitly confirm removal without a prompt')
    .action(async (options) => {
      const root = installRoot();
      if (!options.yes) {
        if (!process.stdin.isTTY || !process.stderr.isTTY)
          throw new Error('Uninstall requires --yes without a terminal.');
        process.stderr.write(
          `Will remove ${root}, ${join(binDirectory(), 'foggy')}, and the FoggyBrain PATH entry.\nTask data in ${dataDirectory()} is kept.\n`,
        );
        const terminal = createInterface({ input: process.stdin, output: process.stderr });
        let answer: string;
        try {
          answer = await terminal.question('Uninstall FoggyBrain? Type yes to confirm: ');
        } finally {
          terminal.close();
        }
        if (answer.trim().toLowerCase() !== 'yes') throw new Error('Uninstall cancelled.');
      }
      output(await uninstall());
    });
```

Add `import { join } from 'node:path';` to `src/cli.ts` if it is not already imported.

- [ ] **Step 6: Add a CLI-level test**

Append to `src/cli.test.ts`:

```ts
test('CLI uninstall refuses to run without --yes outside a terminal and removes the install root with it', async (t) => {
  const { run, requests } = await fixture(t);
  const root = await mkdtemp(join(tmpdir(), 'foggy-cli-uninstall-'));
  const data = await mkdtemp(join(tmpdir(), 'foggy-cli-uninstall-data-'));
  const env = { FOGGY_HOME: root, FOGGY_DATA_DIR: data };
  const refused = await run(['--json', 'uninstall'], env);
  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, '');
  assert.match(JSON.parse(refused.stderr).error, /--yes/);
  const confirmed = await run(['--json', 'uninstall', '--yes'], env);
  assert.equal(confirmed.code, 0);
  const result = JSON.parse(confirmed.stdout) as { removed: string[]; keptDataDir: string };
  assert.deepEqual(result.removed, [root]);
  assert.equal(result.keptDataDir, data);
  assert.equal(requests.length, 0);
});
```

- [ ] **Step 7: Run the tests**

Run: `node --import tsx --test src/cli.test.ts src/install.test.ts`
Expected: PASS.

- [ ] **Step 8: Document `uninstall` in `docs/cli.md`**

In the `## Installation And Upgrades` section, add `foggy uninstall [--yes]` to the `text` block and this paragraph at the end of the section:

````markdown
`foggy uninstall` stops a running server, removes `~/.local/bin/foggy` (only when it points inside the install root, so a `pnpm link --global` executable is left alone), removes the `PATH` entry (`sudo rm -f /etc/paths.d/foggy` on macOS, the marked `~/.profile` line on Linux), and deletes `~/.foggybrain` including every kept version. It returns `{"removed":[...],"pathEntry":"removed","keptDataDir":"..."}`. **Task data is kept**: `~/.local/share/foggybrain` (SQLite state and config) is never touched, so reinstalling restores the same workspaces. Delete that directory by hand to remove your data. Without a terminal, `--yes` is required; with one, the command prompts and expects `yes`.
````

- [ ] **Step 9: Verify all checks**

Run: `pnpm format && pnpm test && pnpm typecheck && pnpm build`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add src/install.ts src/install.test.ts src/cli.ts src/cli.test.ts docs/cli.md
git commit -m "feat: add foggy uninstall"
```

---

### Task 6: `scripts/install.sh` and its smoke test

**Files:**
- Create: `scripts/install.sh` (executable, `chmod +x`)
- Create: `scripts/install-smoke.sh` (executable)
- Modify: `CONTRIBUTING.md` (document the manual smoke test)

**Interfaces:**
- Consumes: the extracted CLI's `link --version <version>` command from Task 3, and the release asset name/layout from the Global Constraints.
- Produces: `scripts/install.sh` honoring `FOGGY_VERSION` and `FOGGY_HOME`; `scripts/install-smoke.sh <version>` running it against a real release in a throwaway `HOME`.

- [ ] **Step 1: Write `scripts/install.sh`**

```sh
#!/bin/sh
# Installs the FoggyBrain CLI from a GitHub release. Usage:
#   curl -fsSL https://raw.githubusercontent.com/LLuque-twilio/foggybrain/master/scripts/install.sh | bash
# Environment: FOGGY_VERSION pins a release (default: latest), FOGGY_HOME relocates ~/.foggybrain.
set -eu

REPO="LLuque-twilio/foggybrain"
FOGGY_HOME="${FOGGY_HOME:-$HOME/.foggybrain}"

fail() {
  printf 'foggybrain install: %s\n' "$1" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v tar >/dev/null 2>&1 || fail "tar is required."
command -v node >/dev/null 2>&1 ||
  fail "Node.js 22.13.0 or newer is required. Install it from https://nodejs.org and re-run this installer."

node -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number);
process.exit(major > 22 || (major === 22 && (minor > 13 || (minor === 13 && patch >= 0))) ? 0 : 1);' ||
  fail "Node.js $(node -v) is too old; FoggyBrain needs 22.13.0 or newer. See https://nodejs.org."

if [ -n "${FOGGY_VERSION:-}" ]; then
  VERSION="${FOGGY_VERSION#v}"
else
  VERSION=$(
    curl -fsSL -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/repos/$REPO/releases/latest" |
      node -e 'let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const tag = JSON.parse(input).tag_name;
  if (typeof tag !== "string") throw new Error("no tag_name");
  process.stdout.write(tag.replace(/^v/, ""));
});'
  ) || fail "Cannot resolve the latest release. Set FOGGY_VERSION to install a specific version."
fi

case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) fail "Invalid version: $VERSION" ;;
esac

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

printf 'Installing FoggyBrain %s...\n' "$VERSION"
curl -fsSL -o "$TMP/foggybrain.tar.gz" \
  "https://github.com/$REPO/releases/download/v$VERSION/foggybrain-$VERSION.tar.gz" ||
  fail "Cannot download release v$VERSION."

DEST="$FOGGY_HOME/versions/$VERSION"
rm -rf "$DEST"
mkdir -p "$DEST"
tar -xzf "$TMP/foggybrain.tar.gz" -C "$DEST" --strip-components=1
[ -f "$DEST/dist/server/cli.js" ] || fail "Release archive is missing dist/server/cli.js."

FOGGY_HOME="$FOGGY_HOME" node "$DEST/dist/server/cli.js" link --version "$VERSION" >/dev/null ||
  fail "Cannot link FoggyBrain $VERSION."

printf 'FoggyBrain %s installed to %s\n' "$VERSION" "$DEST"
printf 'Run: foggy start && foggy dashboard\n'
printf 'Open a new terminal first if foggy is not yet on your PATH.\n'
```

Then: `chmod +x scripts/install.sh`.

- [ ] **Step 2: Check the script parses and lints as POSIX shell**

Run: `sh -n scripts/install.sh && (command -v shellcheck >/dev/null && shellcheck -s sh scripts/install.sh || echo "shellcheck not installed; skipped")`
Expected: no syntax errors; no shellcheck errors if it is installed.

- [ ] **Step 3: Write `scripts/install-smoke.sh`**

```sh
#!/bin/sh
# Manual/CI smoke test: installs a published FoggyBrain release into a throwaway HOME and exercises
# the installed CLI. Requires a real published release. Usage: scripts/install-smoke.sh 0.2.0
set -eu

VERSION="${1:-}"
[ -n "$VERSION" ] || { printf 'usage: %s <version>\n' "$0" >&2; exit 2; }

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT HUP INT TERM

HOME="$SANDBOX/home"
mkdir -p "$HOME"
export HOME
export FOGGY_HOME="$HOME/.foggybrain"
export FOGGY_VERSION="$VERSION"
export FOGGY_DATA_DIR="$SANDBOX/data"
export FOGGY_PORT=4377

sh "$ROOT/scripts/install.sh"

FOGGY="$HOME/.local/bin/foggy"
[ -x "$FOGGY" ] || { printf 'smoke: %s is not executable\n' "$FOGGY" >&2; exit 1; }

# A clean PATH proves the installed CLI needs nothing from the developer environment.
installed=$(env -i HOME="$HOME" PATH="$HOME/.local/bin:/usr/bin:/bin" foggy --version)
[ "$installed" = "$VERSION" ] || { printf 'smoke: expected %s, got %s\n' "$VERSION" "$installed" >&2; exit 1; }

"$FOGGY" --json start >/dev/null
attempt=0
until curl -fsS "http://127.0.0.1:$FOGGY_PORT/api/state" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 100 ] || { "$FOGGY" --json stop >/dev/null 2>&1 || true; printf 'smoke: server never answered\n' >&2; exit 1; }
  sleep 0.1
done
"$FOGGY" --json stop >/dev/null

printf 'smoke: FoggyBrain %s installs, starts, and stops cleanly\n' "$VERSION"
```

Then: `chmod +x scripts/install-smoke.sh && sh -n scripts/install-smoke.sh`.

Note: on Linux the smoke test's `PATH` step writes `$HOME/.profile` inside the sandbox; on macOS `ensurePathEntry` will attempt `sudo` for `/etc/paths.d/foggy`. Run the smoke test on a machine where that prompt is acceptable, or where the file already holds `~/.local/bin`.

- [ ] **Step 4: Document the smoke test in `CONTRIBUTING.md`**

Add a section:

````markdown
## End-User Install Smoke Test

`scripts/install.sh` is the curl installer for end users. It is not covered by `pnpm test` because it needs a real published release. After publishing a tag, verify it against that release:

```sh
scripts/install-smoke.sh 0.2.0
```

The script installs into a throwaway `HOME`, asserts `foggy --version` on a minimal `PATH`, then runs `foggy start` and `foggy stop` on port `4377` with an isolated `FOGGY_DATA_DIR`. It never touches your real `~/.foggybrain` or task data. On macOS it may prompt once for `sudo` to write `/etc/paths.d/foggy`.
````

- [ ] **Step 5: Verify all checks**

Run: `pnpm format && pnpm test && pnpm typecheck && pnpm build`
Expected: all pass (shell scripts are not typechecked; `pnpm format` leaves `.sh` files alone).

- [ ] **Step 6: Commit**

```bash
git add scripts/install.sh scripts/install-smoke.sh CONTRIBUTING.md
git commit -m "feat: add curl installer and its smoke test"
```

---

### Task 7: Release workflow

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `.github/workflows/ci.yml` (add `workflow_call` so the release can reuse it)

**Interfaces:**
- Consumes: `scripts/install.sh`'s expectations — asset named `foggybrain-<version>.tar.gz`, one top-level `foggybrain-<version>/` directory containing `dist/`, `bin/`, `node_modules/`, and `package.json`, with no symlinks.
- Produces: a GitHub Release for tag `v<version>` carrying that asset plus `SHA256SUMS`.

- [ ] **Step 1: Make `ci.yml` callable**

In `.github/workflows/ci.yml`, add `workflow_call:` as the first entry under `on:`:

```yaml
on:
  workflow_call:
  pull_request:
  push:
    branches: [master]
```

- [ ] **Step 2: Create `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    tags: ['v*']

permissions:
  contents: read

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false

jobs:
  checks:
    uses: ./.github/workflows/ci.yml

  publish:
    needs: checks
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: '22'
      - name: Validate the release version
        run: |
          node --input-type=module <<'NODE'
          import assert from 'node:assert/strict';
          import { readFileSync } from 'node:fs';
          const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
          assert.equal(pkg.name, 'foggybrain');
          assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
          assert.equal(process.env.GITHUB_REF_NAME, `v${pkg.version}`);
          NODE
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - name: Package the release archive
        run: |
          VERSION=$(node -p 'require("./package.json").version')
          echo "VERSION=$VERSION" >> "$GITHUB_ENV"
          STAGE="stage/foggybrain-$VERSION"
          mkdir -p "$STAGE"
          cp -R dist bin package.json pnpm-lock.yaml "$STAGE/"
          # A hoisted linker writes real files, so the archive carries no store symlinks.
          pnpm install --dir "$STAGE" --prod --frozen-lockfile --ignore-scripts \
            --config.node-linker=hoisted
          rm -f "$STAGE/pnpm-lock.yaml"
          tar -czf "foggybrain-$VERSION.tar.gz" -C stage "foggybrain-$VERSION"
          if tar -tvzf "foggybrain-$VERSION.tar.gz" | grep -q '^l'; then
            echo "Archive contains symlinks; the packaged node_modules is not self-contained." >&2
            exit 1
          fi
          sha256sum "foggybrain-$VERSION.tar.gz" > SHA256SUMS
      - name: Verify the archive runs without a checkout
        run: |
          mkdir -p verify
          tar -xzf "foggybrain-$VERSION.tar.gz" -C verify --strip-components=1
          test "$(node verify/bin/foggy.mjs --version)" = "$VERSION"
          node verify/bin/foggy.mjs --json stop
        env:
          FOGGY_DATA_DIR: ${{ runner.temp }}/foggy-verify
      - name: Publish the release
        env:
          GH_TOKEN: ${{ github.token }}
          GH_REPO: ${{ github.repository }}
          TAG: ${{ github.ref_name }}
        run: |
          flags=""
          case "$TAG" in *-*) flags="--prerelease" ;; esac
          # shellcheck disable=SC2086
          gh release create "$TAG" "foggybrain-$VERSION.tar.gz" SHA256SUMS \
            --verify-tag --generate-notes --title "FoggyBrain $TAG" $flags
```

- [ ] **Step 3: Validate the workflow files parse**

Run: `node --input-type=module -e "import {readFileSync} from 'node:fs'; for (const f of ['.github/workflows/ci.yml','.github/workflows/release.yml']) readFileSync(f,'utf8');" && (command -v actionlint >/dev/null && actionlint || echo "actionlint not installed; skipped")`
Expected: no errors. If `actionlint` is unavailable, rely on the first real tag run.

- [ ] **Step 4: Verify the packaging steps locally**

Run this from the repo root (it mirrors the workflow's packaging and archive-verification steps):

```bash
pnpm install --frozen-lockfile && pnpm build
VERSION=$(node -p 'require("./package.json").version')
rm -rf /tmp/foggy-pack && STAGE=/tmp/foggy-pack/foggybrain-$VERSION && mkdir -p "$STAGE"
cp -R dist bin package.json pnpm-lock.yaml "$STAGE/"
pnpm install --dir "$STAGE" --prod --frozen-lockfile --ignore-scripts --config.node-linker=hoisted
rm -f "$STAGE/pnpm-lock.yaml"
tar -czf /tmp/foggybrain-$VERSION.tar.gz -C /tmp/foggy-pack "foggybrain-$VERSION"
tar -tvzf /tmp/foggybrain-$VERSION.tar.gz | grep '^l' && echo "SYMLINKS PRESENT (bad)" || echo "no symlinks (good)"
rm -rf /tmp/foggy-verify && mkdir -p /tmp/foggy-verify
tar -xzf /tmp/foggybrain-$VERSION.tar.gz -C /tmp/foggy-verify --strip-components=1
node /tmp/foggy-verify/bin/foggy.mjs --version
du -sh /tmp/foggybrain-$VERSION.tar.gz
```

Expected: "no symlinks (good)", `--version` prints the package version, and the archive size is reported. If `--config.node-linker=hoisted` does not produce real files on the pinned pnpm version, fall back to `npm install --omit=dev --no-package-lock` in the stage directory and update both this step and the workflow to match — the requirement is a self-contained, symlink-free `node_modules`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "ci: publish a release tarball on version tags"
```

---

### Task 8: End-user documentation

**Files:**
- Modify: `README.md` (new install section, developer section relabeled)
- Modify: `docs/local-guide.md` (install path for end users)
- Modify: `AGENTS.md` (one line on the installed CLI)

**Interfaces:**
- Consumes: the commands and layout from Tasks 1–7.
- Produces: no code.

- [ ] **Step 1: Rework the top of `README.md`**

Replace the `## Run Locally` section (through the `pnpm setup` paragraph) with:

````markdown
## Install

Requires **Node.js 22 (22.13.0+)**. Nothing else — no clone, no pnpm.

```sh
curl -fsSL https://raw.githubusercontent.com/LLuque-twilio/foggybrain/master/scripts/install.sh | bash
```

This installs the CLI to `~/.foggybrain/versions/<version>/`, links `~/.local/bin/foggy`, and puts that directory on `PATH` for every shell — including the non-interactive shells AI agents spawn. On macOS it prompts once for `sudo` to write `/etc/paths.d/foggy`; on Linux it appends one line to `~/.profile`. Then:

```sh
foggy start
foggy dashboard
```

Open a new terminal first if `foggy` is not yet on your `PATH`. `foggy upgrade` installs the latest release later; re-running the curl command does the same thing. `FOGGY_VERSION=0.2.0` pins a version. `foggy uninstall` removes the CLI, its `PATH` entry, and `~/.foggybrain`, keeping your task data.

## Run From A Clone (Developers)

```sh
pnpm install
pnpm build
pnpm link --global
pnpm start
```

Open **http://127.0.0.1:4173**. GitHub credentials are optional for local manual tasks.

If linking reports a missing global bin directory, run `pnpm setup`, reopen your terminal, and retry `pnpm link --global`. Restart existing agents/editors to pick up the new `PATH`; their environment must include the directory from `pnpm bin -g`.
````

- [ ] **Step 2: Update the rest of `README.md`**

In `## Develop And Update`, add after the first paragraph: "A curl-installed CLI updates with `foggy upgrade`, independent of any clone. Old versions stay in `~/.foggybrain/versions/` for rollback with `~/.foggybrain/versions/<old>/bin/foggy.mjs link`."

- [ ] **Step 3: Add the install path to `docs/local-guide.md`**

Insert a section before the existing linking instructions (around line 25):

````markdown
## Install Without A Clone

```sh
curl -fsSL https://raw.githubusercontent.com/LLuque-twilio/foggybrain/master/scripts/install.sh | bash
foggy start
foggy dashboard
```

The installer needs Node.js 22.13.0+ and nothing else. Layout:

| Path                                  | Purpose                                              |
| ------------------------------------- | ---------------------------------------------------- |
| `~/.foggybrain/versions/<version>/`   | One extracted release; old versions are kept         |
| `~/.foggybrain/current`               | Symlink to the active version                        |
| `~/.local/bin/foggy`                  | Symlink to `current/bin/foggy.mjs`                   |
| `/etc/paths.d/foggy` (macOS)          | Puts `~/.local/bin` on `PATH` for every shell        |
| `~/.profile` (Linux)                  | Same, via one marked `export PATH` line              |
| `~/.local/share/foggybrain/`          | SQLite data and `foggy.pid`, shared with a dev install |

`FOGGY_HOME` relocates `~/.foggybrain`; `FOGGY_VERSION` pins the release the installer fetches. Data lives in `FOGGY_DATA_DIR` (default `~/.local/share/foggybrain`), so a curl install and a `pnpm link --global` install on the same machine see the same workspaces and tasks. Windows is not supported by the installer; use the clone workflow there.
````

Also update the surrounding prose that says the CLI does not start a server: `foggy start` now does.

- [ ] **Step 4: Add one line to `AGENTS.md`**

In the setup section, after the paragraph about `pnpm dev` / `pnpm start`, add: "An end-user machine may have a curl-installed CLI at `~/.local/bin/foggy` backed by `~/.foggybrain/current`; there, `foggy start` / `foggy stop` manage the server and `foggy upgrade` updates it. The development workflow in this file still applies inside a clone."

- [ ] **Step 5: Verify the docs are consistent**

Run: `pnpm format:check && grep -rn "foggy ui" README.md AGENTS.md docs src; grep -rn "does not start the server" README.md docs`
Expected: `format:check` passes; both greps return nothing.

- [ ] **Step 6: Verify all checks**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add README.md AGENTS.md docs/local-guide.md
git commit -m "docs: document the curl install path for end users"
```

---

## Release Checklist (after Task 8)

Not a code task — the manual sequence that turns this work into a usable install:

1. Bump `package.json` `version` to `0.2.0-rc.1`, commit, `git tag v0.2.0-rc.1`, `git push origin master --tags`.
2. Watch the `Release` workflow; confirm the release carries `foggybrain-0.2.0-rc.1.tar.gz` and `SHA256SUMS`.
3. Run `scripts/install-smoke.sh 0.2.0-rc.1`.
4. On a machine with no prior install, run the curl one-liner, then `foggy start`, `foggy dashboard`, `foggy upgrade`.
5. Bump to `0.2.0`, tag, and push for the first stable release.
