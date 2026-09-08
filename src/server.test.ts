import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DomainError, Store } from './core.js';
import { GithubPoller } from './github.js';
import { createApp, readConfig, type AppOptions } from './server.js';
import type { Snapshot, SyncPreview, SyncStatus, TaskView } from './shared.js';

async function fixture(t: TestContext, options: AppOptions = {}) {
  const store = new Store(':memory:');
  const github = new GithubPoller(store, {
    fetch: async () => {
      assert.fail('GitHub must never use the network in server tests');
    },
  });
  const app = createApp(store, github, options);
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    await github.stop();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    store.close();
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const request = (
    path: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
    raw?: string,
  ) =>
    new Promise<{ status: number; body: any; text: string; headers: IncomingHttpHeaders }>(
      (resolve, reject) => {
        const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port: address.port,
            path,
            method,
            agent: false,
            headers: {
              Host: `127.0.0.1:${options.port ?? 4173}`,
              ...(payload === undefined
                ? {}
                : {
                    'Content-Type': 'application/json',
                    'Content-Length': String(Buffer.byteLength(payload)),
                  }),
              ...headers,
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => {
              chunks.push(chunk);
            });
            res.on('error', reject);
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8');
              const body = res.headers['content-type']?.includes('application/json')
                ? JSON.parse(text)
                : undefined;
              resolve({ status: res.statusCode!, body, text, headers: res.headers });
            });
          },
        );
        req.on('error', reject);
        req.end(payload);
      },
    );
  return { store, github, request };
}

test('server configuration validates ports and intervals, resolves storage, and only accepts env tokens', () => {
  const defaults = readConfig({});
  assert.equal(defaults.port, 4173);
  assert.equal(defaults.intervalMs, 60_000);
  assert.equal(defaults.databasePath, join(homedir(), '.local/share/foggybrain/foggybrain.sqlite'));
  assert.equal(defaults.token, undefined);
  assert.equal(defaults.syncTarget, null);
  assert.equal(defaults.syncToken, undefined);
  const config = readConfig({
    FOGGY_PORT: '5000',
    FOGGY_DATA_DIR: '/tmp/foggybrain-config-test',
    FOGGY_POLL_INTERVAL_MS: '15000',
    GH_TOKEN: ' primary ',
    GITHUB_TOKEN: 'fallback',
  });
  assert.equal(config.port, 5000);
  assert.equal(config.intervalMs, 15_000);
  assert.equal(config.databasePath, '/tmp/foggybrain-config-test/foggybrain.sqlite');
  assert.equal(config.token, 'primary');
  assert.equal(readConfig({ GH_TOKEN: ' ', GITHUB_TOKEN: ' fallback ' }).token, 'fallback');
  for (const FOGGY_PORT of ['', '0', '-1', '65536', '4173.5', '4e3', '4173x'])
    assert.throws(() => readConfig({ FOGGY_PORT }));
  assert.throws(() => readConfig({ FOGGY_DATA_DIR: '' }));
  assert.throws(() => readConfig({ FOGGY_POLL_INTERVAL_MS: '14999' }));
  assert.throws(() => readConfig({ FOGGY_SYNC_REPO: 'owner/state', GH_TOKEN: 'not-a-sync-token' }));
  const sync = readConfig({ FOGGY_SYNC_REPO: 'owner/state', FOGGY_SYNC_TOKEN: 'dedicated-token' });
  assert.deepEqual(sync.syncTarget, {
    repo: 'owner/state',
    branch: 'main',
    path: 'foggybrain/state.json',
  });
  assert.equal(sync.syncToken, 'dedicated-token');
});

test('workspace sync defaults to unconfigured and does not use PR credentials', async (t) => {
  const { request } = await fixture(t);
  const status = await request('/api/sync/status');
  assert.equal(status.status, 200);
  assert.deepEqual(status.body, {
    configured: false,
    target: null,
    lastSync: null,
    dirty: false,
    syncing: false,
  });
  assert.equal((await request('/api/sync/preview', 'POST', {})).status, 503);
});

test('workspace sync routes validate confirmation and preview inputs before delegation', async (t) => {
  const status: SyncStatus = {
    configured: true,
    target: { repo: 'owner/state', branch: 'main', path: 'foggybrain/state.json' },
    lastSync: null,
    dirty: true,
    syncing: false,
  };
  const preview: SyncPreview = {
    previewId: 'reviewed-preview',
    target: status.target!,
    localChanges: [],
    remoteChanges: [],
    conflicts: [{ path: 'tasks/id/title', base: 'base', local: 'local', remote: 'remote' }],
    validationError: null,
    canApply: false,
    resolution: null,
  };
  const calls: unknown[] = [];
  const { request } = await fixture(t, {
    sync: {
      getStatus: () => status,
      preview: async (options) => {
        calls.push(options);
        return preview;
      },
      apply: async (id) => {
        calls.push(id);
        if (id === 'stale') throw new DomainError('Sync preview is stale; re-preview', 409);
        return { ...status, dirty: false };
      },
    },
  });
  assert.deepEqual((await request('/api/sync/status')).body, status);
  assert.deepEqual((await request('/api/sync/preview', 'POST', {})).body, preview);
  assert.deepEqual(
    (await request('/api/sync/preview', 'POST', { resolution: 'remote' })).body,
    preview,
  );
  for (const body of [{ resolution: 'newest' }, { resolution: null }, { token: 'secret' }, []]) {
    assert.equal((await request('/api/sync/preview', 'POST', body)).status, 400);
  }
  for (const body of [
    { previewId: 'reviewed-preview' },
    { previewId: 'reviewed-preview', confirm: 'true' },
    { previewId: 'reviewed-preview', confirm: false },
    { previewId: '', confirm: true },
    { confirm: true },
    { previewId: 'reviewed-preview', confirm: true, resolution: 'local' },
  ])
    assert.equal((await request('/api/sync/apply', 'POST', body)).status, 400);
  assert.equal((await request('/api/sync/preview', 'POST')).status, 415);
  assert.deepEqual(calls, [{}, { resolution: 'remote' }]);
  const applied = await request('/api/sync/apply', 'POST', {
    previewId: 'reviewed-preview',
    confirm: true,
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.dirty, false);
  const stale = await request('/api/sync/apply', 'POST', { previewId: 'stale', confirm: true });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body, { error: 'Sync preview is stale; re-preview' });
  assert.deepEqual(calls, [{}, { resolution: 'remote' }, 'reviewed-preview', 'stale']);
});

test('contract routes preserve core completion, relationship and deletion semantics', async (t) => {
  const { request } = await fixture(t);
  const create = async (body: unknown): Promise<TaskView> => {
    const response = await request('/api/tasks', 'POST', body);
    assert.equal(response.status, 201);
    return response.body;
  };
  const parent = await create({ title: 'Release', kind: 'container' });
  const child = await create({ title: 'Ship', kind: 'manual', parentId: parent.id });
  const shared = await create({ title: 'Security approval', kind: 'manual' });
  const reference = await request('/api/references', 'POST', {
    containerId: parent.id,
    taskId: shared.id,
  });
  assert.equal(reference.status, 201);
  const dependency = await request('/api/dependencies', 'POST', {
    prerequisiteId: shared.id,
    dependentId: child.id,
  });
  assert.equal(dependency.status, 201);
  const update = await request(`/api/tasks/${child.id}`, 'PATCH', {
    title: 'Ship it',
    description: 'Validated',
  });
  assert.equal(update.body.title, 'Ship it');
  assert.equal(update.body.description, 'Validated');
  assert.equal(
    (await request(`/api/tasks/${child.id}/done`, 'POST', { done: true })).body.status,
    'ready',
  );
  await request(`/api/tasks/${shared.id}/done`, 'POST', { done: true });
  let snapshot: Snapshot = (await request('/api/state')).body;
  assert.ok(snapshot.tasks.every((task) => task.status === 'completed'));
  const layout = {
    viewId: parent.id,
    mode: 'manual',
    positions: [{ nodeId: child.id, x: 12, y: -4.5 }],
  };
  assert.deepEqual((await request('/api/layout', 'PUT', layout)).body, layout);
  assert.equal(
    (await request(`/api/tasks/${shared.id}/done`, 'POST', { done: false })).status,
    200,
  );
  snapshot = (await request('/api/state')).body;
  assert.equal(snapshot.tasks.find((task) => task.id === parent.id)!.status, 'available');
  assert.equal(snapshot.tasks.find((task) => task.id === child.id)!.status, 'ready');
  const preview = await request(`/api/tasks/${parent.id}/deletion-preview`);
  assert.equal(preview.status, 200);
  assert.deepEqual(new Set(preview.body.taskIds), new Set([parent.id, child.id]));
  for (const suffix of [
    '',
    '?confirm=false',
    '?confirm=1',
    '?confirm=true&confirm=false',
    '?confirm[yes]=true',
  ]) {
    assert.equal((await request(`/api/tasks/${parent.id}${suffix}`, 'DELETE')).status, 400);
  }
  assert.deepEqual((await request(`/api/references/${reference.body.id}`, 'DELETE')).body, {
    ok: true,
  });
  assert.deepEqual((await request(`/api/dependencies/${dependency.body.id}`, 'DELETE')).body, {
    ok: true,
  });
  const deletion = await request(`/api/tasks/${parent.id}?confirm=true`, 'DELETE');
  assert.equal(deletion.status, 200);
  assert.deepEqual(new Set(deletion.body.deleted), new Set([parent.id, child.id]));
  snapshot = (await request('/api/state')).body;
  assert.deepEqual(
    snapshot.tasks.map((task) => task.id),
    [shared.id],
  );
  assert.deepEqual(snapshot.references, []);
  assert.deepEqual(snapshot.dependencies, []);
  assert.deepEqual(snapshot.layouts, []);
});

test('JSON validation rejects coercible booleans, unsupported fields, invalid types and nonfinite coordinates', async (t) => {
  const { store, request } = await fixture(t);
  const manual = store.createTask({ title: 'Manual', kind: 'manual' });
  for (const done of ['false', 'true', 0, 1, null, [], {}]) {
    assert.equal((await request(`/api/tasks/${manual.id}/done`, 'POST', { done })).status, 400);
  }
  for (const body of [{}, { done: true, surprise: true }, [], null]) {
    assert.equal((await request(`/api/tasks/${manual.id}/done`, 'POST', body)).status, 400);
  }
  assert.equal(store.snapshot().tasks[0].manualDone, false);
  for (const body of [
    { title: 1, kind: 'manual' },
    { title: 'x', kind: true },
    { title: 'x', kind: 'manual', description: null },
    { title: 'x', kind: 'manual', parentId: false },
    { title: 'x', kind: 'pr', prUrl: 42 },
    { title: 'x', kind: 'manual', manualDone: true },
    { title: 'x', kind: 'pr', prUrl: 'https://evil.test/o/r/pull/1' },
  ])
    assert.equal((await request('/api/tasks', 'POST', body)).status, 400);
  for (const body of [
    { title: null },
    { description: [] },
    { prUrl: false },
    { manualDone: true },
  ]) {
    assert.equal((await request(`/api/tasks/${manual.id}`, 'PATCH', body)).status, 400);
  }
  assert.equal(
    (await request('/api/dependencies', 'POST', { prerequisiteId: 1, dependentId: manual.id }))
      .status,
    400,
  );
  assert.equal(
    (await request('/api/references', 'POST', { containerId: manual.id, taskId: null })).status,
    400,
  );
  for (const body of [
    { viewId: 'root', mode: true, positions: [] },
    { viewId: 'root', mode: 'manual', positions: {} },
    { viewId: 'root', mode: 'manual', positions: [{ nodeId: manual.id, x: '1', y: 2 }] },
    { viewId: 'root', mode: 'manual', positions: [null] },
    { viewId: 'root', mode: 'manual', positions: [{ nodeId: manual.id, x: 1, y: 2, extra: true }] },
  ])
    assert.equal((await request('/api/layout', 'PUT', body)).status, 400);
  const overflow = `{"viewId":"root","mode":"manual","positions":[{"nodeId":"${manual.id}","x":1e309,"y":0}]}`;
  assert.equal((await request('/api/layout', 'PUT', undefined, {}, overflow)).status, 400);
});

test('Host and Origin checks reject DNS rebinding, foreign browsers and disallowed local ports without CORS', async (t) => {
  const { request } = await fixture(t, { port: 5000 });
  for (const Host of [
    'evil.test:5000',
    '127.0.0.1.evil.test:5000',
    'localhost.evil.test:5000',
    '127.0.0.1:4173',
    'localhost:3000',
    '[::1]:5000',
    'localhost.',
    'localhost:5000@evil.test',
  ]) {
    const response = await request('/api/state', 'GET', undefined, { Host });
    assert.equal(response.status, 403, Host);
    assert.equal(typeof response.body.error, 'string');
  }
  for (const Origin of [
    'https://evil.test',
    'http://localhost:3000',
    'http://127.0.0.1:4173',
    'null',
    'http://localhost:5000@evil.test',
    'http://localhost:5000/path',
    'http://localhost:5000/',
  ]) {
    assert.equal(
      (await request('/api/tasks', 'POST', { title: 'Attack', kind: 'manual' }, { Origin })).status,
      403,
      Origin,
    );
  }
  for (const Host of ['127.0.0.1:5000', 'localhost:5000', '127.0.0.1:5173', 'localhost:5173']) {
    for (const Origin of [
      'http://127.0.0.1:5000',
      'http://localhost:5000',
      'http://127.0.0.1:5173',
      'http://localhost:5173',
    ]) {
      const response = await request('/api/state', 'GET', undefined, { Host, Origin });
      assert.equal(response.status, 200, `${Host}, ${Origin}`);
      assert.equal(response.headers['access-control-allow-origin'], undefined);
      assert.equal(response.headers['cache-control'], 'no-store');
    }
  }
  assert.equal(
    (await request('/api/state', 'GET', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status,
    403,
  );
  assert.equal(
    (
      await request('/api/state', 'GET', undefined, {
        Host: 'evil.test:5000',
        'X-Forwarded-Host': '127.0.0.1:5000',
      })
    ).status,
    403,
  );
  assert.deepEqual((await request('/api/state')).body.tasks, []);
});

test('errors, unknown endpoints, malformed JSON and oversized bodies always return safe JSON', async (t) => {
  const { store, request } = await fixture(t);
  const checks: [string, string, unknown, Record<string, string>, string | undefined, number][] = [
    ['/api/unknown', 'GET', undefined, {}, undefined, 404],
    ['/api/tasks/missing/deletion-preview', 'GET', undefined, {}, undefined, 404],
    ['/api/tasks', 'POST', undefined, {}, '{"bad":', 400],
    [
      '/api/tasks',
      'POST',
      { title: 'x', kind: 'manual' },
      { 'Content-Type': 'text/plain' },
      undefined,
      415,
    ],
    ['/api/tasks', 'POST', { title: 'x'.repeat(256 * 1024), kind: 'manual' }, {}, undefined, 413],
    ['/api/tasks/%ZZ', 'PATCH', { title: 'x' }, {}, undefined, 400],
    [
      '/api/tasks',
      'POST',
      { title: 'x', kind: 'manual' },
      { 'Content-Type': 'application/json; charset=not-real' },
      undefined,
      415,
    ],
    [
      '/api/tasks',
      'POST',
      { title: 'x', kind: 'manual' },
      { 'Content-Encoding': 'not-real' },
      undefined,
      415,
    ],
  ];
  for (const [path, method, body, headers, raw, expected] of checks) {
    const response = await request(path, method, body, headers, raw);
    assert.equal(response.status, expected, `${path}, expected ${expected}: ${response.text}`);
    assert.deepEqual(Object.keys(response.body), ['error']);
    assert.equal(typeof response.body.error, 'string');
  }
  store.snapshot = () => {
    throw new Error('secret internal database path or token');
  };
  const response = await request('/api/state');
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: 'Internal server error.' });
});

test('GitHub endpoints expose only public status/cache and sync accepts an empty CLI request', async (t) => {
  const { request } = await fixture(t);
  const status = await request('/api/github/status');
  assert.equal(status.status, 200);
  assert.deepEqual(Object.keys(status.body).sort(), [
    'configured',
    'error',
    'lastSync',
    'login',
    'syncing',
  ]);
  assert.equal(status.body.configured, false);
  assert.deepEqual((await request('/api/github/prs')).body, []);
  assert.equal((await request('/api/github/sync', 'POST')).status, 200);
  assert.equal((await request('/api/github/sync', 'POST', {})).status, 200);
  assert.equal(
    (await request('/api/github/sync', 'POST', { token: 'must-not-be-accepted' })).status,
    400,
  );
  assert.deepEqual((await request('/api/health')).body, { ok: true });
});

test('production web root serves the built UI and assets, never swallowing unknown API routes', async (t) => {
  const webRoot = mkdtempSync(join(tmpdir(), 'foggybrain-web-test-'));
  t.after(() => {
    rmSync(webRoot, { recursive: true, force: true });
  });
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Foggybrain test UI</title>');
  writeFileSync(join(webRoot, 'app.js'), 'console.log("test asset");');
  writeFileSync(join(webRoot, '.env'), 'DO_NOT_SERVE=secret');
  const { request } = await fixture(t, { webRoot });
  const index = await request('/');
  assert.equal(index.status, 200);
  assert.match(index.text, /Foggybrain test UI/);
  assert.equal((await request('/app.js')).status, 200);
  assert.equal((await request('/.env')).status, 404);
  assert.equal((await request('/api/missing')).status, 404);
  assert.equal((await request('/', 'GET', undefined, { Host: 'evil.test:4173' })).status, 403);
});

test('real Store derives PR merge gates and propagates reopened verified state after polling', async (t) => {
  const store = new Store(':memory:');
  t.after(() => {
    store.close();
  });
  const pr = store.createTask({
    title: 'External change',
    kind: 'pr',
    prUrl: 'https://github.com/other/repo/pull/1',
  });
  const dependent = store.createTask({ title: 'Release', kind: 'manual' });
  store.addDependency(pr.id, dependent.id);
  store.setDone(dependent.id, true);
  let merged = true;
  const poller = new GithubPoller(store, {
    token: 'not-a-real-token',
    fetch: async (input) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://api.github.com');
      const body =
        url.pathname === '/user'
          ? { login: 'me' }
          : url.pathname === '/search/issues'
            ? { items: [], total_count: 0, incomplete_results: false }
            : { state: merged ? 'closed' : 'open', merged };
      return new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  assert.equal((await poller.sync()).error, null);
  assert.ok(store.snapshot().tasks.every((task) => task.status === 'completed'));
  merged = false;
  await poller.sync();
  assert.equal(store.snapshot().tasks.find((task) => task.id === dependent.id)!.status, 'ready');
  assert.equal(store.snapshot().tasks.find((task) => task.id === pr.id)!.prState, 'open');
});
