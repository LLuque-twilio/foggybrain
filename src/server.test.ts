import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DomainError, Store } from './core.js';
import { GithubPoller } from './github.js';
import { createApp, readConfig, startServer, type AppOptions } from './server.js';
import { WorkspaceManager } from './workspaces.js';
import type { Snapshot, SyncPreview, SyncStatus, TaskView } from './shared.js';

async function fixture(t: TestContext, options: AppOptions = {}) {
  const store = new Store(':memory:');
  const github = new GithubPoller(store, {
    fetch: async () => {
      assert.fail('GitHub must never use the network in server tests');
    },
  });
  const app = createApp(
    options.workspaces ? null : store,
    options.workspaces ? null : github,
    options,
  );
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

test('workspace removal requires strict reviewed confirmation and reroutes the default across restart', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'foggy-removal-api-'));
  const workspaces = new WorkspaceManager({
    dataDir,
    fetch: async () => assert.fail('No remote calls'),
  });
  t.after(async () => {
    await workspaces.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const other = workspaces.create({ name: 'Replacement', type: 'local' });
  const task = workspaces
    .get(other.id)
    .store.createTask({ title: 'Replacement task', kind: 'manual' });
  const { request } = await fixture(t, { workspaces });
  const path = '/api/workspaces/default';
  const preview = await request(`${path}/removal-preview`);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers['cache-control'], 'no-store');
  const body = { revision: preview.body.revision };
  for (const query of ['', '?confirm=false', '?confirm=true&confirm=true', '?confirm=true&extra=x'])
    assert.equal((await request(path + query, 'DELETE', body)).status, 400);
  assert.equal((await request(`${path}?confirm=true`, 'DELETE')).status, 415);
  for (const invalid of [{}, { revision: '' }, { revision: 2 }, { ...body, confirm: true }, []])
    assert.equal((await request(`${path}?confirm=true`, 'DELETE', invalid)).status, 400);
  workspaces.update('default', { name: 'Changed' });
  assert.equal((await request(`${path}?confirm=true`, 'DELETE', body)).status, 409);
  const reviewed = (await request(`${path}/removal-preview`)).body;
  const removed = await request(`${path}?confirm=true`, 'DELETE', { revision: reviewed.revision });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.defaultWorkspaceId, other.id);
  assert.equal((await request('/api/state')).body.tasks[0].id, task.id);
  assert.equal((await request(`${path}/state`)).status, 404);
  assert.equal((await request(`${path}/removal-preview`)).status, 404);
  const last = (await request(`/api/workspaces/${other.id}/removal-preview`)).body;
  assert.equal(last.canRemove, true);
  assert.equal(
    (await request(`/api/workspaces/${other.id}`, 'DELETE', { revision: last.revision })).status,
    400,
  );
  assert.equal(
    (await request(`/api/workspaces/${other.id}?confirm=true`, 'DELETE', { revision: 'stale' }))
      .status,
    409,
  );
  assert.equal(
    (
      await request(`/api/workspaces/${other.id}?confirm=true`, 'DELETE', {
        revision: last.revision,
      })
    ).status,
    200,
  );
  await workspaces.close();
  const reopened = new WorkspaceManager({ dataDir });
  t.after(() => reopened.close());
  const restarted = await fixture(t, { workspaces: reopened });
  assert.deepEqual((await restarted.request('/api/workspaces')).body, {
    workspaces: [],
    defaultWorkspaceId: null,
    limit: 3,
  });
  assert.deepEqual((await restarted.request('/api/health')).body, { ok: true });
  for (const endpoint of ['/state', '/github/status', '/sync/status']) {
    const response = await restarted.request(`/api${endpoint}`);
    assert.equal(response.status, 404);
    assert.match(response.body.error, /No workspace selected/);
    assert.equal((await restarted.request(`/api/workspaces/${other.id}${endpoint}`)).status, 404);
  }
  assert.equal((await restarted.request('/api/workspaces/repositories')).status, 503);
  const created = await restarted.request('/api/workspaces', 'POST', {
    name: 'New first',
    type: 'local',
  });
  assert.equal(created.status, 201);
  assert.equal(
    (await restarted.request('/api/workspaces')).body.defaultWorkspaceId,
    created.body.id,
  );
  assert.equal((await restarted.request('/api/state')).status, 200);
  assert.equal((await restarted.request('/api/workspaces/default/state')).status, 404);
});

test('startServer serves an empty registry without creating a placeholder database', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'foggy-empty-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dataDir = mkdtempSync(join(tmpdir(), 'foggy-empty-startup-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const manager = new WorkspaceManager({ dataDir });
  try {
    await manager.remove('default', { revision: manager.removalPreview('default').revision });
  } finally {
    await manager.close();
  }
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const env = {
    HOME: home,
    FOGGY_DATA_DIR: dataDir,
    FOGGY_PORT: String(address.port),
    FOGGY_SYNC_REPO: 'owner/state',
    FOGGY_SYNC_BRANCH: 'main',
    FOGGY_SYNC_PATH: 'state.json',
    FOGGY_SYNC_TOKEN: '',
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
    PATH: '',
    FOGGY_POLL_INTERVAL_MS: '60000',
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  delete process.env.FOGGY_SYNC_TOKEN;
  try {
    const running = await startServer({ loadEnv: false });
    try {
      const base = `http://127.0.0.1:${address.port}/api`;
      assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true });
      assert.deepEqual(await (await fetch(`${base}/workspaces`)).json(), {
        workspaces: [],
        defaultWorkspaceId: null,
        limit: 3,
      });
      assert.equal((await fetch(`${base}/state`)).status, 404);
      assert.deepEqual(
        readdirSync(dataDir).filter((file) => file !== 'workspaces.sqlite'),
        [],
      );
      const response = await fetch(`${base}/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'First', type: 'local' }),
      });
      assert.equal(response.status, 201);
      assert.equal((await fetch(`${base}/state`)).status, 200);
      assert.equal((await fetch(`${base}/workspaces/default/state`)).status, 404);
    } finally {
      await running.close();
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('repository discovery is unscoped, credential-specific, read-only and sanitized', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'foggy-repositories-'));
  const authorizations: string[] = [];
  let failure = false;
  const workspaces = new WorkspaceManager({
    dataDir,
    dedicatedToken: 'dedicated-secret',
    githubToken: 'github-secret',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://api.github.com');
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.method ?? 'GET', 'GET');
      authorizations.push(new Headers(init?.headers).get('Authorization')!);
      if (failure) throw new Error('dedicated-secret github-secret');
      if (url.pathname === '/user') return Response.json({ id: 1, login: 'owner' });
      if (url.pathname === '/repos/owner/state')
        return Response.json({
          private: true,
          full_name: 'owner/state',
          owner: { id: 1, login: 'owner', type: 'User' },
        });
      if (url.pathname === '/repos/owner/state/branches') return Response.json([{ name: 'trunk' }]);
      if (url.pathname === '/repos/owner/state/branches/trunk')
        return Response.json({ name: 'trunk', commit: { sha: 'a'.repeat(40) } });
      if (url.pathname === `/repos/owner/state/git/trees/${'a'.repeat(40)}`)
        return Response.json({
          truncated: false,
          tree: [{ path: 'state.json', type: 'blob', mode: '100644' }],
        });
      assert.equal(url.pathname, '/user/repos');
      assert.equal(url.searchParams.get('affiliation'), 'owner');
      assert.equal(url.searchParams.get('visibility'), 'private');
      return Response.json([
        {
          id: 2,
          name: 'state',
          full_name: 'owner/state',
          private: true,
          default_branch: 'trunk',
          owner: { id: 1, login: 'owner', type: 'User' },
          secret: 'must-not-return',
        },
      ]);
    },
  });
  t.after(async () => {
    await workspaces.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const { request } = await fixture(t, { workspaces });
  const before = workspaces.list();
  for (const credential of ['dedicated', 'github']) {
    authorizations.length = 0;
    const result = await request(`/api/workspaces/repositories?credential=${credential}`);
    assert.equal(result.status, 200);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.deepEqual(result.body, {
      login: 'owner',
      repositories: [{ id: 2, fullName: 'owner/state', defaultBranch: 'trunk' }],
    });
    assert.deepEqual(authorizations, [
      `Bearer ${credential}-secret`,
      `Bearer ${credential}-secret`,
    ]);
    for (const endpoint of ['branches', 'files']) {
      authorizations.length = 0;
      const response = await request(
        `/api/workspaces/${endpoint}?credential=${credential}&repo=owner/state${endpoint === 'files' ? '&branch=trunk' : ''}`,
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.deepEqual(
        response.body,
        endpoint === 'files' ? { paths: ['state.json'] } : { branches: ['trunk'] },
      );
      assert.ok(authorizations.every((value) => value === `Bearer ${credential}-secret`));
    }
  }
  for (const query of [
    'credential=bad',
    'credential=github&credential=dedicated',
    'token=secret',
    'url=https://evil.example',
  ])
    assert.equal((await request(`/api/workspaces/repositories?${query}`)).status, 400);
  assert.equal((await request('/api/workspaces/default/workspaces/repositories')).status, 404);
  assert.equal(
    (
      await request('/api/workspaces/repositories', 'GET', undefined, {
        Origin: 'https://evil.example',
      })
    ).status,
    403,
  );
  failure = true;
  const failed = await request('/api/workspaces/repositories');
  assert.equal(failed.status, 502);
  assert.equal(failed.text.includes('secret'), false);
  for (const endpoint of ['branches', 'files']) {
    const url = `/api/workspaces/${endpoint}?credential=github&repo=owner/state${endpoint === 'files' ? '&branch=trunk' : ''}`;
    const response = await request(url);
    assert.equal(response.status, 502);
    assert.equal(response.text.includes('secret'), false);
    assert.equal(
      (await request(url, 'GET', undefined, { Origin: 'https://evil.example' })).status,
      403,
    );
    assert.equal((await request(`/api/workspaces/default/workspaces/${endpoint}`)).status, 404);
  }
  assert.deepEqual(workspaces.list(), before);
});

test('repository discovery does not fall back when the selected credential is unavailable', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'foggy-repositories-'));
  const workspaces = new WorkspaceManager({
    dataDir,
    githubToken: 'available',
    fetch: async () => assert.fail('No fallback'),
  });
  t.after(async () => {
    await workspaces.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const { request } = await fixture(t, { workspaces });
  const result = await request('/api/workspaces/repositories');
  assert.equal(result.status, 503);
  assert.match(result.body.error, /FOGGY_SYNC_TOKEN/);
  for (const endpoint of ['branches', 'files']) {
    const query = `repo=owner/state&credential=dedicated${endpoint === 'files' ? '&branch=feature%2Fstate' : ''}`;
    assert.equal((await request(`/api/workspaces/${endpoint}?${query}`)).status, 503);
    for (const invalid of [
      '',
      'repo=owner/state',
      `${query}&token=secret`,
      `${query}&credential=github`,
      query.replace('owner/state', 'owner/..'),
      query.replace('dedicated', 'invalid'),
      endpoint === 'files' ? query.replace('feature%2Fstate', '..') : `${query}&branch=main`,
    ])
      assert.equal((await request(`/api/workspaces/${endpoint}?${invalid}`)).status, 400);
  }
});

test('workspace APIs scope domain state and preserve fixed-default compatibility', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'foggy-server-workspaces-'));
  const workspaces = new WorkspaceManager({
    dataDir,
    fetch: async () => assert.fail('No network'),
  });
  t.after(async () => {
    await workspaces.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const { request } = await fixture(t, { workspaces });
  const listed = await request('/api/workspaces');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.defaultWorkspaceId, 'default');
  const created = await request('/api/workspaces', 'POST', { name: 'Work', type: 'local' });
  assert.equal(created.status, 201);
  const prefix = `/api/workspaces/${created.body.id}`;
  const task = await request(`${prefix}/tasks`, 'POST', { title: 'Work only', kind: 'manual' });
  assert.equal(task.status, 201);
  assert.equal((await request('/api/state')).body.tasks.length, 0);
  assert.equal((await request('/api/workspaces/default/state')).body.tasks.length, 0);
  assert.equal((await request(`${prefix}/state`)).body.tasks[0].id, task.body.id);
  assert.equal(
    (await request(`/api/tasks/${task.body.id}`, 'PATCH', { title: 'Wrong workspace' })).status,
    404,
  );
  assert.equal(
    (await request(`${prefix}/tasks/${task.body.id}/done`, 'POST', { done: true })).body.status,
    'completed',
  );
  assert.equal(
    (await request('/api/tasks', 'POST', { title: 'Default only', kind: 'manual' })).status,
    201,
  );
  assert.equal(
    (await request('/api/workspaces/default/state')).body.tasks[0].title,
    'Default only',
  );
  assert.equal((await request(`${prefix}/github/sync`, 'POST')).status, 200);
  assert.equal((await request(`${prefix}/sync/status`)).body.configured, false);
  assert.equal((await request(`${prefix}/sync/preview`, 'POST', {})).status, 503);
  assert.equal((await request('/api/workspaces/missing/state')).status, 404);
  assert.equal((await request(prefix, 'PATCH', { name: 'Renamed' })).body.name, 'Renamed');
  assert.equal((await request(prefix, 'PATCH', { secret: 'not-allowed' })).status, 400);
  assert.equal(
    (await request('/api/workspaces', 'POST', { name: 'Third', type: 'local' })).status,
    201,
  );
  assert.equal(
    (await request('/api/workspaces', 'POST', { name: 'Fourth', type: 'local' })).status,
    409,
  );
});

test('legacy cloud restart without its dedicated token serves local APIs and rejects sync operations', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'foggy-legacy-restart-'));
  const env = { FOGGY_DATA_DIR: dataDir, FOGGY_SYNC_REPO: 'owner/state' };
  const initial = readConfig({ ...env, FOGGY_SYNC_TOKEN: 'dedicated-token' });
  const first = new WorkspaceManager({
    dataDir,
    legacyTarget: initial.syncTarget,
    dedicatedToken: initial.syncToken,
  });
  const task = first
    .get('default')
    .store.createTask({ title: 'Available offline', kind: 'manual' });
  await first.close();

  const settings = readConfig(env);
  const workspaces = new WorkspaceManager({
    dataDir: settings.dataDir,
    legacyTarget: settings.syncTarget,
    dedicatedToken: settings.syncToken,
    fetch: async () => assert.fail('Missing credentials must not trigger remote calls'),
  });
  t.after(async () => {
    await workspaces.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  workspaces.start();
  const { request } = await fixture(t, { workspaces });
  assert.equal((await request('/api/workspaces')).body.workspaces[0].type, 'cloud');
  for (const prefix of ['/api', '/api/workspaces/default']) {
    assert.equal((await request(`${prefix}/state`)).body.tasks[0].id, task.id);
    const status = await request(`${prefix}/sync/status`);
    assert.equal(status.status, 200);
    assert.equal(status.body.configured, true);
    assert.deepEqual(status.body.target, initial.syncTarget);
    for (const [operation, body] of [
      ['preview', {}],
      ['apply', { previewId: 'reviewed-id', confirm: true }],
    ] as const) {
      const response = await request(`${prefix}/sync/${operation}`, 'POST', body);
      assert.equal(response.status, 503);
      assert.match(response.body.error, /Set FOGGY_SYNC_TOKEN/);
    }
  }
  assert.equal(
    (await request(`/api/tasks/${task.id}`, 'PATCH', { title: 'Edited offline' })).status,
    200,
  );
});

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
  const withoutSyncToken = readConfig({
    FOGGY_SYNC_REPO: 'owner/state',
    GH_TOKEN: 'not-a-sync-token',
  });
  assert.equal(withoutSyncToken.syncTarget?.repo, 'owner/state');
  assert.equal(withoutSyncToken.syncToken, undefined);
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
    mode: 'merge',
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
  for (const mode of ['merge', 'revert']) {
    assert.equal((await request('/api/sync/preview', 'POST', { mode })).status, 200);
  }
  for (const body of [
    { resolution: 'newest' },
    { resolution: null },
    { token: 'secret' },
    [],
    { mode: null },
    { mode: 'reset' },
    { mode: true },
    { mode: 'revert', resolution: 'local' },
    { mode: 'revert', resolution: 'remote' },
  ]) {
    assert.equal((await request('/api/sync/preview', 'POST', body)).status, 400);
  }
  for (const body of [
    { previewId: 'reviewed-preview' },
    { previewId: 'reviewed-preview', confirm: 'true' },
    { previewId: 'reviewed-preview', confirm: false },
    { previewId: '', confirm: true },
    { confirm: true },
    { previewId: 'reviewed-preview', confirm: true, resolution: 'local' },
    { previewId: 'reviewed-preview', confirm: true, mode: 'revert' },
  ])
    assert.equal((await request('/api/sync/apply', 'POST', body)).status, 400);
  assert.equal((await request('/api/sync/preview', 'POST')).status, 415);
  assert.deepEqual(calls, [{}, { resolution: 'remote' }, { mode: 'merge' }, { mode: 'revert' }]);
  const applied = await request('/api/sync/apply', 'POST', {
    previewId: 'reviewed-preview',
    confirm: true,
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.dirty, false);
  const stale = await request('/api/sync/apply', 'POST', { previewId: 'stale', confirm: true });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body, { error: 'Sync preview is stale; re-preview' });
  assert.deepEqual(calls, [
    {},
    { resolution: 'remote' },
    { mode: 'merge' },
    { mode: 'revert' },
    'reviewed-preview',
    'stale',
  ]);
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

test('connection API returns the connected TaskView and preserves branches in both insertion directions', async (t) => {
  const { store, request } = await fixture(t);
  for (const direction of ['prerequisite', 'dependent'] as const) {
    const a = store.createTask({ title: 'A', kind: 'manual' });
    const b = store.createTask({ title: 'B', kind: 'manual' });
    const branch = store.createTask({ title: 'Branch', kind: 'manual' });
    const selected = store.addDependency(a.id, b.id);
    const retained = [store.addDependency(a.id, branch.id), store.addDependency(branch.id, b.id)];
    store.setDone(a.id, true);
    store.setDone(branch.id, true);
    store.setDone(b.id, true);
    const anchor = direction === 'prerequisite' ? b : a;
    const path = `/api/tasks/${anchor.id}/connections`;
    const response = await request(path, 'POST', {
      direction,
      dependencyId: selected.id,
      task: { title: '  PR gate  ', kind: 'pr', prUrl: 'https://github.com/O/R/pull/001/' },
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers['cache-control'], 'no-store');
    const connected: TaskView = response.body;
    assert.notEqual(connected.id, anchor.id);
    assert.equal(connected.title, 'PR gate');
    assert.equal(connected.prUrl, 'https://github.com/o/r/pull/1');
    assert.equal(connected.prState, 'unknown');
    assert.equal(connected.status, 'available');
    assert.deepEqual(connected.waitingOn, []);
    const snapshot: Snapshot = (await request('/api/state')).body;
    assert.deepEqual(
      connected,
      snapshot.tasks.find((task) => task.id === connected.id),
    );
    assert.equal(snapshot.tasks.find((task) => task.id === b.id)!.status, 'ready');
    assert.equal(snapshot.tasks.find((task) => task.id === branch.id)!.status, 'completed');
    assert.ok(!snapshot.dependencies.some((edge) => edge.id === selected.id));
    for (const edge of retained)
      assert.deepEqual(
        snapshot.dependencies.find((item) => item.id === edge.id),
        edge,
      );
    assert.ok(
      snapshot.dependencies.some(
        (edge) => edge.prerequisiteId === a.id && edge.dependentId === connected.id,
      ),
    );
    assert.ok(
      snapshot.dependencies.some(
        (edge) => edge.prerequisiteId === connected.id && edge.dependentId === b.id,
      ),
    );

    const existing = store.createTask({ title: 'Existing', kind: 'manual' });
    const leaf = await request(path, 'POST', { direction, taskId: existing.id });
    assert.equal(leaf.status, 201);
    assert.equal(leaf.body.id, existing.id);
    const redundant = store.addDependency(
      direction === 'prerequisite' ? a.id : existing.id,
      direction === 'prerequisite' ? existing.id : b.id,
    );
    const incident = store
      .snapshot()
      .dependencies.find((edge) =>
        direction === 'prerequisite'
          ? edge.prerequisiteId === connected.id && edge.dependentId === b.id
          : edge.prerequisiteId === a.id && edge.dependentId === connected.id,
      )!;
    const inserted = await request(path, 'POST', {
      direction,
      taskId: existing.id,
      dependencyId: incident.id,
    });
    assert.equal(inserted.status, 201);
    assert.equal(inserted.body.id, existing.id);
    assert.deepEqual(
      store.snapshot().dependencies.find((edge) => edge.id === redundant.id),
      redundant,
    );
    const before = store.snapshot();
    const stale = await request(path, 'POST', {
      direction,
      dependencyId: incident.id,
      task: { title: 'Must not exist', kind: 'manual' },
    });
    assert.equal(stale.status, 404);
    assert.deepEqual(Object.keys(stale.body), ['error']);
    assert.deepEqual(store.snapshot(), before);
  }
});

test('connection API rejects malformed requests, missing tasks, mismatched edges and membership cycles without partial writes', async (t) => {
  const { store, request } = await fixture(t);
  const group = store.createTask({ title: 'Group', kind: 'container' });
  const a = store.createTask({ title: 'A', kind: 'manual', parentId: group.id });
  const b = store.createTask({ title: 'B', kind: 'manual' });
  const edge = store.addDependency(a.id, b.id);
  const path = `/api/tasks/${b.id}/connections`;
  const valid = { direction: 'prerequisite', dependencyId: edge.id };
  const task = { title: 'New', kind: 'manual' };
  const checks: [unknown, number][] = [
    [null, 400],
    [[], 400],
    [{}, 400],
    [{ ...valid }, 400],
    [{ ...valid, taskId: a.id, task }, 400],
    [{ ...valid, task, extra: true }, 400],
    [{ ...valid, task, direction: 'before' }, 400],
    ...[null, 1, '', {}, []].map((taskId): [unknown, number] => [{ ...valid, taskId }, 400]),
    ...[null, 1, '', {}, []].map((dependencyId): [unknown, number] => [
      { ...valid, task, dependencyId },
      400,
    ]),
    ...[
      null,
      [],
      {},
      { ...task, parentId: 42 },
      { ...task, manualDone: true },
      { title: 'PR', kind: 'pr' },
      { ...task, title: '' },
    ].map((task): [unknown, number] => [{ ...valid, task }, 400]),
    [{ ...valid, taskId: 'missing' }, 404],
    [{ ...valid, task: { ...task, parentId: 'missing' } }, 404],
    [{ ...valid, task, dependencyId: 'missing' }, 404],
    [{ ...valid, task, direction: 'dependent' }, 409],
    [{ ...valid, taskId: b.id }, 409],
    [{ ...valid, taskId: a.id }, 409],
    [{ direction: 'prerequisite', taskId: a.id }, 409],
    [{ direction: 'dependent', taskId: a.id }, 409],
    [{ ...valid, task: { ...task, parentId: group.id }, direction: 'dependent' }, 409],
  ];
  const before = store.snapshot();
  for (const [body, status] of checks) {
    const response = await request(path, 'POST', body);
    assert.equal(response.status, status, JSON.stringify(body));
    assert.deepEqual(Object.keys(response.body), ['error']);
    assert.equal(typeof response.body.error, 'string');
    assert.deepEqual(store.snapshot(), before);
  }
  const cycle = await request(`/api/tasks/${group.id}/connections`, 'POST', {
    direction: 'dependent',
    task: { ...task, parentId: group.id },
  });
  assert.equal(cycle.status, 409);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(
    (await request('/api/tasks/missing/connections', 'POST', { direction: 'dependent', task }))
      .status,
    404,
  );
  assert.equal((await request(path, 'POST')).status, 415);
  assert.equal(
    (await request(path, 'POST', undefined, { 'Content-Type': 'application/json' })).status,
    400,
  );
  assert.deepEqual(store.snapshot(), before);
});

test('connections are workspace scoped with no cross-workspace task, parent or edge fallback', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'foggy-connections-api-'));
  const workspaces = new WorkspaceManager({
    dataDir,
    fetch: async () => assert.fail('No network'),
  });
  t.after(async () => {
    await workspaces.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const other = workspaces.create({ name: 'Other', type: 'local' });
  const { request } = await fixture(t, { workspaces });
  const defaultStore = workspaces.get('default').store;
  const scopedStore = workspaces.get(other.id).store;
  const parent = defaultStore.createTask({ title: 'Default parent', kind: 'container' });
  const defaultTask = defaultStore.createTask({ title: 'Default task', kind: 'manual' });
  const defaultEdge = defaultStore.addDependency(defaultTask.id, parent.id);
  const anchor = scopedStore.createTask({ title: 'Scoped anchor', kind: 'manual' });
  const prefix = `/api/workspaces/${other.id}`;
  const task = { title: 'Scoped new', kind: 'container' };
  const response = await request(`${prefix}/tasks/${anchor.id}/connections`, 'POST', {
    direction: 'prerequisite',
    task,
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.kind, 'container');
  assert.equal(response.body.status, 'available');
  assert.equal(response.body.ownSatisfied, false);
  const before = scopedStore.snapshot();
  const defaultBefore = defaultStore.snapshot();
  const checks: [string, unknown][] = [
    [
      `${prefix}/tasks/${anchor.id}/connections`,
      { direction: 'dependent', taskId: defaultTask.id },
    ],
    [
      `${prefix}/tasks/${anchor.id}/connections`,
      { direction: 'dependent', task: { ...task, parentId: parent.id } },
    ],
    [
      `${prefix}/tasks/${anchor.id}/connections`,
      { direction: 'dependent', task, dependencyId: defaultEdge.id },
    ],
    [`${prefix}/tasks/${defaultTask.id}/connections`, { direction: 'dependent', task }],
    [`/api/tasks/${anchor.id}/connections`, { direction: 'dependent', task }],
    [
      `/api/workspaces/missing/tasks/${defaultTask.id}/connections`,
      { direction: 'dependent', task },
    ],
  ];
  for (const [path, body] of checks) {
    assert.equal((await request(path, 'POST', body)).status, 404);
    assert.deepEqual(scopedStore.snapshot(), before);
    assert.deepEqual(defaultStore.snapshot(), defaultBefore);
  }
  const leaf = await request(
    `/api/workspaces/default/tasks/${defaultTask.id}/connections`,
    'POST',
    {
      direction: 'prerequisite',
      task: { title: 'Default leaf', kind: 'manual' },
    },
  );
  assert.equal(leaf.status, 201);
  const snapshot: Snapshot = (await request('/api/state')).body;
  assert.ok(snapshot.tasks.some((task) => task.id === leaf.body.id));
  assert.deepEqual(scopedStore.snapshot(), before);
});

test('manual PR gates support create, attach, replace and nullable removal over HTTP', async (t) => {
  const { store, request } = await fixture(t);
  const created = await request('/api/tasks', 'POST', {
    title: 'Manual',
    kind: 'manual',
    prUrl: 'https://github.com/O/R/pull/001/',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.prUrl, 'https://github.com/o/r/pull/1');
  const path = `/api/tasks/${created.body.id}`;
  assert.equal((await request(`${path}/done`, 'POST', { done: true })).body.status, 'available');
  store.updatePr(created.body.id, {
    state: 'merged',
    checkedAt: '2026-09-08T12:00:00Z',
    error: null,
  });
  const changed = await request(path, 'PATCH', { prUrl: 'https://github.com/o/r/pull/2' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.status, 'available');
  assert.equal(changed.body.prState, 'unknown');
  const removed = await request(path, 'PATCH', { prUrl: null });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.status, 'completed');
  assert.equal(removed.body.prUrl, null);
  assert.equal(
    (await request(path, 'PATCH', { prUrl: 'https://github.com/o/r/pull/3' })).body.status,
    'available',
  );
  for (const kind of ['manual', 'pr', 'container'])
    assert.equal(
      (await request('/api/tasks', 'POST', { title: 'Invalid', kind, prUrl: null })).status,
      400,
    );
  const pr = store.createTask({ title: 'PR', kind: 'pr', prUrl: 'https://github.com/o/r/pull/1' });
  const container = store.createTask({ title: 'Container', kind: 'container' });
  for (const task of [pr, container]) {
    const before = store.snapshot();
    assert.equal(
      (await request(`/api/tasks/${task.id}`, 'PATCH', { title: 'Invalid', prUrl: null })).status,
      400,
    );
    assert.deepEqual(store.snapshot(), before);
  }
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
