import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test, type TestContext } from 'node:test';
import type { DeletionPreview, Snapshot, SyncPreview, SyncStatus, TaskView } from './shared.js';

const task = (id: string, extra: Partial<TaskView> = {}): TaskView => ({
  id,
  title: `Task ${id}`,
  description: '',
  kind: 'manual',
  parentId: null,
  manualDone: false,
  prUrl: null,
  prState: 'unknown',
  prCheckedAt: null,
  prError: null,
  createdAt: '2026-09-08T00:00:00.000Z',
  updatedAt: '2026-09-08T00:00:00.000Z',
  status: 'available',
  ownSatisfied: false,
  waitingOn: [],
  childrenIds: [],
  ...extra,
});
const snapshot: Snapshot = {
  tasks: [
    task('c', { kind: 'container', childrenIds: ['a', 'b'] }),
    task('a', { parentId: 'c' }),
    task('b', { status: 'ready', manualDone: true, ownSatisfied: true, waitingOn: ['a'] }),
    task('outside'),
  ],
  dependencies: [{ id: 'dep-1', prerequisiteId: 'a', dependentId: 'b' }],
  references: [{ id: 'ref-1', containerId: 'c', taskId: 'b' }],
  layouts: [],
};
const preview: DeletionPreview = {
  taskIds: ['c', 'a'],
  affectedTasks: [snapshot.tasks[2]],
  removedDependencies: snapshot.dependencies,
  removedReferences: snapshot.references,
};
type Request = { method: string; path: string; body?: unknown };

async function fixture(
  t: TestContext,
  responder?: (request: Request) => { status?: number; body: unknown; raw?: boolean },
) {
  const requests: Request[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString();
    const request = {
      method: req.method!,
      path: req.url!,
      ...(text ? { body: JSON.parse(text) } : {}),
    };
    requests.push(request);
    const result = responder?.(request) ?? {
      body:
        request.path === '/api/state'
          ? snapshot
          : request.path.endsWith('/deletion-preview')
            ? preview
            : request.method === 'DELETE'
              ? { deleted: ['c', 'a'] }
              : { id: 'server-id', ...(request.body as object) },
    };
    res.writeHead(result.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(result.raw ? String(result.body) : JSON.stringify(result.body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', fileURLToPath(new URL('./cli.ts', import.meta.url)), ...args],
        {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          env: { ...process.env, FOGGY_URL: url, NO_COLOR: '1', ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 30_000,
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end();
    });
  return { requests, run, url };
}

test('CLI create uses commander, preserves arguments, uses server IDs, and honors --url over FOGGY_URL', async (t) => {
  const { run, requests, url } = await fixture(t);
  const title = 'Ship "search"; $(not-a-command)';
  const result = await run(
    [
      'task',
      'create',
      title,
      '--kind',
      'pr',
      '--parent',
      'c',
      '--pr',
      'https://github.com/acme/app/pull/42',
      '--description',
      'Two\nlines',
      '--json',
      '--url',
      url,
    ],
    { FOGGY_URL: 'http://127.0.0.1:1' },
  );
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    id: 'server-id',
    title,
    kind: 'pr',
    parentId: 'c',
    prUrl: 'https://github.com/acme/app/pull/42',
    description: 'Two\nlines',
  });
  assert.deepEqual(requests, [
    {
      method: 'POST',
      path: '/api/tasks',
      body: {
        title,
        kind: 'pr',
        parentId: 'c',
        prUrl: 'https://github.com/acme/app/pull/42',
        description: 'Two\nlines',
      },
    },
  ]);
});

test('CLI list filters ownership/status; show includes children and relationship IDs; graph scopes shared children', async (t) => {
  const { run } = await fixture(t);
  const list = await run(['--json', 'task', 'list', '--parent', 'root', '--status', 'ready']);
  assert.equal(list.code, 0);
  assert.equal(list.stderr, '');
  assert.deepEqual(JSON.parse(list.stdout), [snapshot.tasks[2]]);
  const owned = await run(['task', 'list', '--parent', 'c', '--json']);
  assert.deepEqual(
    JSON.parse(owned.stdout).map((task: TaskView) => task.id),
    ['a'],
  );
  const show = await run(['task', 'show', 'c', '--json']);
  assert.equal(show.code, 0);
  assert.deepEqual(JSON.parse(show.stdout).children, snapshot.tasks.slice(1, 3));
  assert.deepEqual(JSON.parse(show.stdout).references, snapshot.references);
  const ready = JSON.parse((await run(['--json', 'task', 'show', 'b'])).stdout);
  assert.deepEqual(ready.prerequisites, [snapshot.tasks[1]]);
  assert.deepEqual(ready.dependencies, snapshot.dependencies);
  const graph = await run(['--json', 'graph', 'c']);
  assert.equal(graph.code, 0);
  assert.deepEqual(JSON.parse(graph.stdout), {
    ...snapshot,
    viewId: 'c',
    tasks: snapshot.tasks.slice(0, 3),
  });
  assert.deepEqual(JSON.parse((await run(['graph', '--json'])).stdout), {
    viewId: 'root',
    ...snapshot,
  });
});

test('pnpm source invocation forwards CLI flags and keeps agent JSON output clean', async (t) => {
  const { url } = await fixture(t);
  const options = {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, FOGGY_URL: 'http://127.0.0.1:1', NO_COLOR: '1' },
    timeout: 30_000,
  };
  const result = await promisify(execFile)(
    'pnpm',
    ['--silent', 'run', 'foggy', '--url', url, '--json', 'task', 'list', '--status', 'ready'],
    options,
  );
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), [snapshot.tasks[2]]);

  await assert.rejects(
    promisify(execFile)(
      'pnpm',
      ['--silent', 'run', 'foggy', '--url', url, '--json', 'task', 'delete', 'c'],
      options,
    ),
    (error: unknown) => {
      const failure = error as { code: number; stdout: string; stderr: string };
      assert.equal(failure.code, 1);
      assert.equal(failure.stdout, '');
      assert.match(JSON.parse(failure.stderr).error, /Deletion requires --yes/);
      return true;
    },
  );
});

test('CLI update/done/reopen and relationship commands send exact endpoint bodies', async (t) => {
  const { run, requests } = await fixture(t);
  const cases: [string[], Request][] = [
    [
      ['task', 'create', 'Default'],
      { method: 'POST', path: '/api/tasks', body: { title: 'Default', kind: 'manual' } },
    ],
    [
      ['task', 'update', 'a/b', '--description', ''],
      { method: 'PATCH', path: '/api/tasks/a%2Fb', body: { description: '' } },
    ],
    [
      ['task', 'update', 'a', '--title', 'New', '--pr', 'https://github.com/acme/app/pull/2'],
      {
        method: 'PATCH',
        path: '/api/tasks/a',
        body: { title: 'New', prUrl: 'https://github.com/acme/app/pull/2' },
      },
    ],
    [['task', 'done', 'a'], { method: 'POST', path: '/api/tasks/a/done', body: { done: true } }],
    [['task', 'reopen', 'a'], { method: 'POST', path: '/api/tasks/a/done', body: { done: false } }],
    [
      ['dependency', 'add', 'a', 'b'],
      {
        method: 'POST',
        path: '/api/dependencies',
        body: { prerequisiteId: 'a', dependentId: 'b' },
      },
    ],
    [['dependency', 'remove', 'dep-1'], { method: 'DELETE', path: '/api/dependencies/dep-1' }],
    [
      ['reference', 'add', 'c', 'b'],
      { method: 'POST', path: '/api/references', body: { containerId: 'c', taskId: 'b' } },
    ],
    [['reference', 'remove', 'ref-1'], { method: 'DELETE', path: '/api/references/ref-1' }],
  ];
  for (const [args, expected] of cases) {
    const result = await run(['--json', ...args]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(JSON.parse(result.stdout));
    assert.deepEqual(requests.at(-1), expected);
  }
});

test('CLI deletion rejects non-TTY confirmation, dry-run never deletes, and --yes always previews first', async (t) => {
  const { run, requests } = await fixture(t);
  for (const prefix of [[], ['--json']]) {
    const result = await run([...prefix, 'task', 'delete', 'c']);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(JSON.parse(result.stderr).error, /requires --yes/);
  }
  assert.ok(requests.every((request) => request.method === 'GET'));
  for (const flags of [['--dry-run'], ['--dry-run', '--yes']]) {
    const result = await run(['--json', 'task', 'delete', 'c', ...flags]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { ...preview, tasks: snapshot.tasks.slice(0, 2) });
  }
  assert.ok(requests.every((request) => request.method === 'GET'));
  const confirmed = await run(['task', 'delete', 'c', '--yes', '--json']);
  assert.equal(confirmed.code, 0);
  assert.equal(confirmed.stderr, '');
  assert.deepEqual(JSON.parse(confirmed.stdout), { deleted: ['c', 'a'] });
  assert.deepEqual(requests.slice(-3), [
    { method: 'GET', path: '/api/tasks/c/deletion-preview' },
    { method: 'GET', path: '/api/state' },
    { method: 'DELETE', path: '/api/tasks/c?confirm=true' },
  ]);
});

test('CLI GitHub commands preserve status errors as data and use server-side endpoints', async (t) => {
  const status = {
    configured: true,
    login: 'octocat',
    lastSync: null,
    error: 'Rate limited',
    syncing: false,
  };
  const { run, requests } = await fixture(t, (request) => ({
    body: request.path.endsWith('/prs') ? [] : status,
  }));
  for (const name of ['status', 'prs', 'sync']) {
    const result = await run(['github', name, '--json']);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), name === 'prs' ? [] : status);
    assert.deepEqual(requests.at(-1), {
      method: name === 'sync' ? 'POST' : 'GET',
      path: `/api/github/${name}`,
    });
  }
});

test('CLI state sync forwards status, previews, conflicts, and explicit apply with exact requests', async (t) => {
  const target = { repo: 'owner/private-state', branch: 'main', path: 'foggybrain/state.json' };
  const status: SyncStatus = {
    configured: true,
    target,
    lastSync: null,
    dirty: true,
    syncing: false,
  };
  const syncPreview: SyncPreview = {
    previewId: 'server-preview-id',
    target,
    localChanges: [{ collection: 'tasks', id: 'a', title: 'Remote title', kind: 'updated' }],
    remoteChanges: [],
    conflicts: [
      { path: 'tasks/a/title', base: 'Old', local: 'Local title', remote: 'Remote title' },
    ],
    validationError: null,
    canApply: false,
    resolution: null,
  };
  const { run, requests } = await fixture(t, (request) => ({
    body: request.path === '/api/sync/preview' ? syncPreview : status,
  }));
  const cases: [string[], Request, SyncStatus | SyncPreview][] = [
    [['status'], { method: 'GET', path: '/api/sync/status' }, status],
    [['preview'], { method: 'POST', path: '/api/sync/preview', body: {} }, syncPreview],
    ...(['local', 'remote'] as const).map((resolution): [string[], Request, SyncPreview] => [
      ['preview', '--resolve', resolution],
      { method: 'POST', path: '/api/sync/preview', body: { resolution } },
      syncPreview,
    ]),
    [
      ['apply', 'server-preview-id', '--yes'],
      {
        method: 'POST',
        path: '/api/sync/apply',
        body: { previewId: 'server-preview-id', confirm: true },
      },
      status,
    ],
  ];
  for (const [args, expected, body] of cases) {
    requests.length = 0;
    const result = await run(['--json', 'sync', ...args]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `${JSON.stringify(body)}\n`);
    assert.deepEqual(requests, [expected]);
  }
  syncPreview.validationError = 'No common sync baseline';
  const blocked = await run(['--json', 'sync', 'preview']);
  assert.equal(blocked.code, 0);
  assert.equal(blocked.stderr, '');
  assert.deepEqual(JSON.parse(blocked.stdout), syncPreview);
  syncPreview.conflicts = [];
  syncPreview.validationError = null;
  syncPreview.canApply = true;
  const clean = await run(['--json', 'sync', 'preview']);
  assert.equal(clean.code, 0);
  assert.equal(clean.stderr, '');
  assert.deepEqual(JSON.parse(clean.stdout), syncPreview);
});

test('CLI state sync requires explicit --yes and valid Commander arguments without API calls', async (t) => {
  const { run, requests } = await fixture(t);
  for (const prefix of [[], ['--json']]) {
    const result = await run([...prefix, 'sync', 'apply', 'reviewed-id']);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), {
      error: 'State sync apply requires --yes. Inspect sync preview before confirming.',
    });
  }
  for (const args of [
    [],
    ['apply', '--yes'],
    ['preview', '--resolve', 'force'],
    ['preview', '--resolve'],
  ]) {
    const result = await run(['--json', 'sync', ...args]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(typeof JSON.parse(result.stderr).error, 'string');
  }
  assert.deepEqual(requests, []);
});

test('CLI state sync HTTP errors propagate without retries or automatic previews', async (t) => {
  for (const [args, status, error, expected] of [
    [['status'], 503, 'State sync is not configured', { method: 'GET', path: '/api/sync/status' }],
    [
      ['preview'],
      502,
      'GitHub state request failed',
      { method: 'POST', path: '/api/sync/preview', body: {} },
    ],
    [
      ['apply', 'stale-id', '--yes'],
      409,
      'Sync preview is stale; re-preview',
      {
        method: 'POST',
        path: '/api/sync/apply',
        body: { previewId: 'stale-id', confirm: true },
      },
    ],
  ] as const) {
    const { run, requests } = await fixture(t, () => ({ status, body: { error } }));
    const result = await run(['--json', 'sync', ...args]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${JSON.stringify({ error: `HTTP ${status}: ${error}` })}\n`);
    assert.deepEqual(requests, [expected]);
  }
});

test('CLI server errors and invalid JSON produce one JSON stderr value and no stdout', async (t) => {
  for (const response of [
    { status: 409, body: { error: 'Dependency would create a cycle' } },
    { status: 503, body: '<html>Unavailable</html>', raw: true },
    { status: 200, body: 'not-json', raw: true },
  ]) {
    const { run } = await fixture(t, () => response);
    const result = await run(['--json', 'task', 'list']);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(JSON.parse(result.stderr).error, new RegExp(`HTTP ${response.status}`));
  }
  const { run, requests } = await fixture(t, () => ({
    status: 404,
    body: { error: 'Task not found' },
  }));
  const deletion = await run(['task', 'delete', 'missing', '--yes', '--json']);
  assert.equal(deletion.code, 1);
  assert.match(JSON.parse(deletion.stderr).error, /Task not found/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET');
});

test('CLI commander and local validation errors are JSON, including without --json', async (t) => {
  const { run, requests } = await fixture(t);
  for (const args of [
    [],
    ['task'],
    ['--json', 'unknown'],
    ['task', 'create'],
    ['task', 'create', 'X', '--kind', 'wrong'],
    ['task', 'list', '--status', 'done'],
    ['task', 'list', '--wat'],
    ['task', 'show', 'a', 'extra'],
    ['task', 'update', 'a'],
    ['--url', 'file:///tmp', 'task', 'list'],
    ['--url', 'not a URL', 'ui'],
    ['--url', 'http://user:secret@localhost', 'task', 'list'],
  ]) {
    const result = await run(args);
    assert.equal(result.code, 1, JSON.stringify(args));
    assert.equal(result.stdout, '');
    assert.equal(typeof JSON.parse(result.stderr).error, 'string');
  }
  assert.equal(requests.length, 0);
  const missing = await run(['--json', 'task', 'show', 'missing']);
  assert.equal(missing.code, 1);
  assert.match(JSON.parse(missing.stderr).error, /Task not found/);
  const nonContainer = await run(['--json', 'graph', 'a']);
  assert.equal(nonContainer.code, 1);
  assert.match(JSON.parse(nonContainer.stderr).error, /Not a container/);
  const unreachable = await run(['--url', 'http://127.0.0.1:1', '--json', 'graph']);
  assert.equal(unreachable.code, 1);
  assert.equal(unreachable.stdout, '');
  assert.match(JSON.parse(unreachable.stderr).error, /Cannot reach Foggybrain/);
  const help = await run(['task', 'delete', '--help']);
  assert.equal(help.code, 0);
  assert.equal(help.stderr, '');
  assert.match(help.stdout, /--dry-run/);
});

test('CLI human graph shows relationship directions and IDs; empty JSON lists remain arrays', async (t) => {
  const { run } = await fixture(t);
  const result = await run(['graph', 'c']);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /a\tavailable\tmanual\t"Task a"\tparent=c/);
  assert.match(result.stdout, /dep-1\ta -> b/);
  assert.match(result.stdout, /ref-1\tc -> b/);
  const empty = await run(['--json', 'task', 'list', '--status', 'completed']);
  assert.equal(empty.code, 0);
  assert.deepEqual(JSON.parse(empty.stdout), []);
});

test('CLI scoped graph deduplicates nested shared children and excludes external edges without rewriting waitingOn', async (t) => {
  const nested: Snapshot = {
    tasks: [
      task('c', { kind: 'container', childrenIds: ['nested', 'shared'] }),
      task('nested', { kind: 'container', parentId: 'c', childrenIds: ['shared'] }),
      task('shared', { status: 'blocked', waitingOn: ['external'] }),
      task('external'),
    ],
    dependencies: [{ id: 'external-dep', prerequisiteId: 'external', dependentId: 'shared' }],
    references: [
      { id: 'r1', containerId: 'c', taskId: 'shared' },
      { id: 'r2', containerId: 'nested', taskId: 'shared' },
    ],
    layouts: [
      { viewId: 'c', mode: 'auto', positions: [] },
      { viewId: 'root', mode: 'auto', positions: [] },
    ],
  };
  const { run } = await fixture(t, () => ({ body: nested }));
  const result = await run(['--json', 'graph', 'c']);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    viewId: 'c',
    tasks: nested.tasks.slice(0, 3),
    dependencies: [],
    references: nested.references,
    layouts: [nested.layouts[0]],
  });
});

test('CLI import is inert and ui passes a single URL argument to a platform opener without a shell', async () => {
  const code = `
    import assert from 'node:assert/strict';
    import childProcess from 'node:child_process';
    import { EventEmitter } from 'node:events';
    import { syncBuiltinESMExports } from 'node:module';
    const original = childProcess.spawn;
    let calls = 0;
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
    const url = 'http://example.test;touch/';
    childProcess.spawn = (executable, args, options) => {
      if (executable !== opener) return original(executable, args, options);
      calls++;
      assert.deepEqual(args, process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]);
      assert.equal(options.shell, false);
      assert.equal(options.stdio, 'ignore');
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    };
    syncBuiltinESMExports();
    const { main } = await import('./src/cli.ts');
    assert.equal(calls, 0);
    await main(['node', 'foggy', '--url', url, '--json', 'ui']);
    assert.equal(calls, 1);
  `;
  const result = await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', code],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      timeout: 30_000,
    },
  );
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { url: 'http://example.test;touch/', opened: true });
});

test('CLI terminal deletion lists deleted and affected IDs/titles; yes confirms and EOF cancels safely', async (t) => {
  const { requests, url } = await fixture(t);
  for (const answer of ['yes', 'no', 'EOF']) {
    const code = `
      import assert from 'node:assert/strict';
      import readline from 'node:readline/promises';
      import { EventEmitter } from 'node:events';
      import { syncBuiltinESMExports } from 'node:module';
      Object.defineProperty(process.stdin, 'isTTY', { value: true });
      Object.defineProperty(process.stderr, 'isTTY', { value: true });
      readline.createInterface = options => {
        assert.equal(options.output, process.stderr);
        const terminal = new EventEmitter();
        terminal.close = () => terminal.emit('close');
        terminal.question = (prompt, options) => {
          process.stderr.write(prompt);
          if (${JSON.stringify(answer)} !== 'EOF') return Promise.resolve(${JSON.stringify(answer)});
          return new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('Aborted')));
            queueMicrotask(() => terminal.close());
          });
        };
        return terminal;
      };
      syncBuiltinESMExports();
      const { main } = await import('./src/cli.ts');
      await main(['node', 'foggy', '--url', ${JSON.stringify(url)}, '--json', 'task', 'delete', 'c']);
    `;
    const result = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', code],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        timeout: 30_000,
      },
    ).then(
      (result) => ({ ...result, code: 0 }),
      (error: { code: number; stdout: string; stderr: string }) => error,
    );
    assert.equal(result.code, answer === 'yes' ? 0 : 1, result.stderr);
    for (const id of ['c', 'a', 'b']) assert.ok(result.stderr.includes(`${id}\t"Task ${id}"`));
    assert.match(result.stderr, /Type yes to confirm/);
    if (answer === 'yes') assert.deepEqual(JSON.parse(result.stdout), { deleted: ['c', 'a'] });
    else {
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /\{"error":"Deletion cancelled\."\}/);
    }
  }
  assert.equal(requests.filter((request) => request.method === 'DELETE').length, 1);
});
