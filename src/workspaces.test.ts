import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { DomainError, Store } from './core.js';
import { WorkspaceManager, type WorkspaceManagerOptions } from './workspaces.js';

const target = { repo: 'owner/state', branch: 'main', path: 'foggybrain/state.json' };
const secret = 'workspace-test-secret';
const noNetwork: typeof fetch = async () => {
  assert.fail('Unexpected remote request');
};

test('removes cloud default locally, persists replacement, preserves others and reuses capacity', async (t) => {
  const dataDir = directory(t);
  const first = manager(t, { dataDir, legacyTarget: target });
  const store = first.get('default').store;
  const container = store.createTask({ title: 'Container', kind: 'container' });
  const task = store.createTask({ title: 'Task', kind: 'manual' });
  const dependent = store.createTask({ title: 'Dependent', kind: 'manual' });
  store.addReference(container.id, task.id);
  store.addDependency(task.id, dependent.id);
  const replacement = first.create({ name: 'Replacement', type: 'local' });
  const other = first.create({ name: 'Other', type: 'local' });
  first.get(replacement.id).store.createTask({ title: 'Keep', kind: 'manual' });
  const before = first.get(replacement.id).store.snapshot();
  const otherBefore = first.get(other.id).store.snapshot();
  writeFileSync(join(dataDir, 'foggybrain.sqlite.backup'), 'unrelated');
  const preview = first.removalPreview('default');
  assert.equal(preview.taskCount, 3);
  assert.equal(preview.dependencyCount, 1);
  assert.equal(preview.referenceCount, 1);
  assert.equal(preview.dirty, true);
  assert.equal(preview.canRemove, true);
  const list = await first.remove('default', { revision: preview.revision });
  assert.equal(list.defaultWorkspaceId, replacement.id);
  for (const suffix of ['', '-wal', '-shm', '-journal'])
    assert.equal(existsSync(join(dataDir, `foggybrain.sqlite${suffix}`)), false);
  assert.equal(existsSync(join(dataDir, 'foggybrain.sqlite.backup')), true);
  assert.deepEqual(first.get(replacement.id).store.snapshot(), before);
  assert.deepEqual(first.get(other.id).store.snapshot(), otherBefore);
  assert.throws(() => first.get('default'), /not found/);
  assert.ok(first.create({ name: 'Reused slot', type: 'local' }));
  await first.close();
  const reopened = manager(t, { dataDir, legacyTarget: target });
  assert.equal(reopened.list().defaultWorkspaceId, replacement.id);
  assert.equal(reopened.list().workspaces[0].type, 'local');
  assert.deepEqual(reopened.get(replacement.id).store.snapshot(), before);
  assert.throws(() => reopened.get('default'), /not found/);
  assert.equal(existsSync(join(dataDir, 'foggybrain.sqlite')), false);
});

test('non-default removal deletes only its exact database and a replacement default can also be removed', async (t) => {
  const dataDir = directory(t);
  const workspaces = manager(t, { dataDir });
  const other = workspaces.create({ name: 'Other', type: 'local' });
  const before = workspaces.get('default').store.snapshot();
  const path = join(dataDir, `workspace-${other.id}.sqlite`);
  const preview = workspaces.removalPreview(other.id);
  assert.equal(existsSync(path), true);
  await workspaces.remove(other.id, { revision: preview.revision });
  assert.equal(workspaces.list().defaultWorkspaceId, 'default');
  assert.deepEqual(workspaces.get('default').store.snapshot(), before);
  for (const suffix of ['', '-wal', '-shm', '-journal'])
    assert.equal(existsSync(path + suffix), false);
  const replacement = workspaces.create({ name: 'Replacement', type: 'local' });
  const survivor = workspaces.create({ name: 'Survivor', type: 'local' });
  const stale = workspaces.removalPreview(replacement.id);
  await workspaces.remove('default', { revision: workspaces.removalPreview('default').revision });
  await assert.rejects(workspaces.remove(replacement.id, { revision: stale.revision }), /stale/);
  await workspaces.remove(replacement.id, {
    revision: workspaces.removalPreview(replacement.id).revision,
  });
  assert.equal(workspaces.list().defaultWorkspaceId, survivor.id);
  assert.equal(workspaces.removalPreview(survivor.id).canRemove, true);
  await workspaces.close();
  const reopened = manager(t, { dataDir, legacyTarget: target });
  assert.deepEqual(reopened.list().workspaces, [survivor]);
  assert.equal(reopened.list().defaultWorkspaceId, survivor.id);
});

test('removal rejects stale graph, layout, configuration and registry previews', async (t) => {
  const workspaces = manager(t, { dataDir: directory(t) });
  const last = workspaces.removalPreview('default');
  assert.equal(last.canRemove, true);
  const other = workspaces.create({ name: 'Other', type: 'local' });
  const store = workspaces.get('default').store;
  for (const change of [
    () => store.createTask({ title: 'New', kind: 'manual' }),
    () => store.saveLayout({ viewId: 'root', mode: 'manual', positions: [] }),
    () => workspaces.update('default', { name: 'Renamed' }),
    () => workspaces.update(other.id, { name: 'Other renamed' }),
    () => workspaces.create({ name: 'Third', type: 'local' }),
  ]) {
    const preview = workspaces.removalPreview('default');
    change();
    await assert.rejects(
      workspaces.remove('default', { revision: preview.revision }),
      (error: unknown) =>
        error instanceof DomainError && error.status === 409 && /stale/.test(error.message),
    );
  }
  for (const input of [
    null,
    [],
    {},
    { revision: '' },
    { revision: 1 },
    { revision: 'x', extra: true },
  ])
    await assert.rejects(workspaces.remove('default', input), DomainError);
});

test('removal barriers precede teardown and close waits for removal', async (t) => {
  const dataDir = directory(t);
  const workspaces = manager(t, { dataDir });
  const other = workspaces.create({ name: 'Other', type: 'local' });
  const runtime = workspaces.get('default');
  let release!: () => void;
  const stopped = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(runtime.github, 'stop', () => stopped);
  const removal = workspaces.remove('default', {
    revision: workspaces.removalPreview('default').revision,
  });
  assert.throws(() => workspaces.get('default'), /in progress/);
  assert.throws(() => workspaces.update('default', { name: 'No' }), /in progress/);
  await assert.rejects(workspaces.remove('default', { revision: 'x' }), /in progress/);
  assert.throws(() => new WorkspaceManager({ dataDir }), /in progress/);
  assert.equal(workspaces.get(other.id).store.snapshot().tasks.length, 0);
  const closing = workspaces.close();
  let closed = false;
  void closing.then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.doesNotThrow(() => runtime.store.snapshot());
  release();
  await removal;
  await closing;
  assert.throws(() => runtime.store.snapshot());
  assert.equal(existsSync(join(dataDir, 'foggybrain.sqlite')), false);
});

test('active sync and another in-process manager block removal', async (t) => {
  const dataDir = directory(t);
  let release!: () => void;
  const response = new Promise<Response>((resolve) => {
    release = () => resolve(Response.json({ private: true }));
  });
  const first = manager(t, {
    dataDir,
    legacyTarget: target,
    dedicatedToken: secret,
    fetch: async () => response,
  });
  first.create({ name: 'Other', type: 'local' });
  const preview = first.removalPreview('default');
  const second = manager(t, { dataDir });
  second.get('default');
  assert.match(first.removalPreview('default').reason!, /single active manager/);
  await assert.rejects(
    first.remove('default', { revision: preview.revision }),
    /single active manager/,
  );
  await second.close();
  const sync = first.get('default').sync.preview();
  assert.match(first.removalPreview('default').reason!, /sync is active/);
  await assert.rejects(first.remove('default', { revision: preview.revision }), /sync is active/);
  release();
  await sync.catch(() => {});
  await first.remove('default', { revision: first.removalPreview('default').revision });
});

test('durable tombstones retry failed final workspace cleanup without resurrecting default', async (t) => {
  const dataDir = directory(t);
  const first = manager(t, { dataDir });
  const preview = first.removalPreview('default');
  const obstruction = join(dataDir, 'foggybrain.sqlite-journal');
  mkdirSync(obstruction);
  await assert.rejects(first.remove('default', { revision: preview.revision }));
  assert.equal(first.list().defaultWorkspaceId, null);
  assert.throws(() => first.get('default'), /not found/);
  await first.close();
  assert.throws(() => new WorkspaceManager({ dataDir }));
  rmSync(obstruction, { recursive: true });
  writeFileSync(join(dataDir, 'foggybrain.sqlite-wal'), 'leftover');
  const reopened = manager(t, { dataDir, legacyTarget: target });
  assert.deepEqual(reopened.list(), { workspaces: [], defaultWorkspaceId: null, limit: 3 });
  assert.equal(existsSync(join(dataDir, 'foggybrain.sqlite-wal')), false);
  assert.throws(() => reopened.get('default'), /not found/);
});

test('migrates NOT NULL settings, persists final removal and transactionally restores the first default', async (t) => {
  const dataDir = directory(t);
  const registry = new DatabaseSync(join(dataDir, 'workspaces.sqlite'));
  registry.exec(`
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, config TEXT NOT NULL);
    CREATE TABLE workspace_settings (id INTEGER PRIMARY KEY CHECK (id = 1), default_id TEXT NOT NULL);
    INSERT INTO workspace_settings VALUES (1, 'default');
  `);
  registry.prepare('INSERT INTO workspaces VALUES (?, ?)').run(
    'default',
    JSON.stringify({
      name: 'Existing',
      type: 'local',
      target: null,
      credential: null,
    }),
  );
  registry.close();
  const first = manager(t, { dataDir });
  assert.equal(first.list().workspaces[0].name, 'Existing');
  first.get('default').store.createTask({ title: 'Delete me', kind: 'manual' });
  const preview = first.removalPreview('default');
  assert.equal(preview.canRemove, true);
  assert.equal(preview.reason, null);
  assert.equal(preview.taskCount, 1);
  const empty = { workspaces: [], defaultWorkspaceId: null, limit: 3 };
  assert.deepEqual(await first.remove('default', { revision: preview.revision }), empty);
  await first.close();
  const reopened = manager(t, { dataDir, legacyTarget: target });
  reopened.start();
  assert.deepEqual(reopened.list(), empty);
  assert.deepEqual(
    readdirSync(dataDir).filter(
      (file) => file.includes('foggybrain') || file.startsWith('workspace-'),
    ),
    [],
  );
  assert.throws(() => reopened.get('default'), /not found/);
  assert.throws(() => reopened.create({ name: '', type: 'local' }));
  assert.throws(() => reopened.create({ name: 'No credential', type: 'cloud', target }));
  assert.deepEqual(reopened.list(), empty);
  const peer = manager(t, { dataDir });
  const restored = reopened.create({ name: 'Restored', type: 'local' });
  peer.create({ name: 'Second', type: 'local' });
  assert.equal(peer.list().defaultWorkspaceId, restored.id);
  assert.equal(reopened.list().defaultWorkspaceId, restored.id);
  await peer.close();
  await reopened.close();
  const restarted = manager(t, { dataDir, legacyTarget: target });
  assert.equal(restarted.list().defaultWorkspaceId, restored.id);
  assert.deepEqual(restarted.list().workspaces[0], restored);
});

function directory(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'foggy-workspaces-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function manager(t: TestContext, options: WorkspaceManagerOptions) {
  const result = new WorkspaceManager({ fetch: noNetwork, ...options });
  t.after(() => result.close());
  return result;
}

test('migrates legacy storage and persists registry, names, separate graphs and the cap', async (t) => {
  const dataDir = directory(t);
  const legacy = new Store(join(dataDir, 'foggybrain.sqlite'));
  const task = legacy.createTask({ title: 'Keep me', kind: 'manual' });
  legacy.close();
  const first = manager(t, { dataDir, legacyTarget: target, dedicatedToken: secret });
  assert.deepEqual(first.list(), {
    workspaces: [
      { id: 'default', name: 'Personal', type: 'cloud', target, credential: 'dedicated' },
    ],
    defaultWorkspaceId: 'default',
    limit: 3,
  });
  assert.equal(first.get('default').store.snapshot().tasks[0].id, task.id);
  const second = first.create({ name: 'Work', type: 'local' });
  const third = first.create({ name: 'Other', type: 'local' });
  assert.notEqual(second.id, third.id);
  assert.equal(first.get(second.id).store.snapshot().tasks.length, 0);
  first.get(second.id).store.createTask({ title: 'Only work', kind: 'manual' });
  assert.equal(first.get('default').store.snapshot().tasks.length, 1);
  first.update(second.id, { name: 'Renamed' });
  assert.throws(() => first.create({ name: 'Fourth', type: 'local' }), /limit of 3/);
  await first.close();
  const reopened = manager(t, { dataDir, dedicatedToken: secret });
  assert.equal(reopened.list().workspaces[1].name, 'Renamed');
  assert.equal(reopened.get(second.id).store.snapshot().tasks[0].title, 'Only work');
  assert.equal(reopened.get('default').store.snapshot().tasks[0].id, task.id);
  assert.throws(() => reopened.create({ name: 'Fourth', type: 'local' }), /limit of 3/);
  for (const file of readdirSync(dataDir))
    assert.equal(readFileSync(join(dataDir, file)).includes(Buffer.from(secret)), false, file);
});

test('late legacy configuration converts only the local default and preserves data and name', async (t) => {
  const dataDir = directory(t);
  const first = manager(t, { dataDir });
  first.update('default', { name: 'My personal work' });
  const store = first.get('default').store;
  const task = store.createTask({ title: 'Keep local work', kind: 'manual' });
  store.saveLayout({
    viewId: 'root',
    mode: 'manual',
    positions: [{ nodeId: task.id, x: 10, y: 20 }],
  });
  const before = store.snapshot();
  const other = first.create({ name: 'Other', type: 'local' });
  first.create({ name: 'Third', type: 'local' });
  await first.close();

  const converted = manager(t, { dataDir, legacyTarget: target });
  const expected = {
    id: 'default',
    name: 'My personal work',
    type: 'cloud',
    target,
    credential: 'dedicated',
  };
  assert.deepEqual(converted.list().workspaces[0], expected);
  assert.equal(converted.list().workspaces.length, 3);
  assert.deepEqual(converted.list().workspaces[1], other);
  assert.deepEqual(converted.get('default').store.snapshot(), before);
  assert.deepEqual(converted.get('default').sync.getStatus().target, target);
  await converted.close();

  for (const legacyTarget of [target, { ...target, repo: 'other/repo' }, null]) {
    const reopened = manager(t, { dataDir, legacyTarget });
    assert.deepEqual(reopened.list().workspaces[0], expected);
    assert.deepEqual(reopened.get('default').store.snapshot(), before);
    await reopened.close();
  }
});

test('legacy configuration cannot override a default connected with GitHub credentials', async (t) => {
  const dataDir = directory(t);
  const first = manager(t, { dataDir, githubToken: secret });
  const connected = first.update('default', {
    name: 'Connected',
    type: 'cloud',
    target,
    credential: 'github',
  });
  await first.close();
  const reopened = manager(t, { dataDir, legacyTarget: { ...target, path: 'different.json' } });
  assert.deepEqual(reopened.list().workspaces[0], connected);
});

test('registry transactions enforce cap across manager instances', (t) => {
  const dataDir = directory(t);
  const a = manager(t, { dataDir });
  const b = manager(t, { dataDir });
  a.create({ name: 'A', type: 'local' });
  b.create({ name: 'B', type: 'local' });
  assert.throws(() => a.create({ name: 'C', type: 'local' }), /limit/);
  assert.equal(b.list().workspaces.length, 3);
});

test('dedicated is the default and missing restart credentials block sync, not local data', async (t) => {
  const dataDir = directory(t);
  const first = manager(t, { dataDir, dedicatedToken: secret });
  const cloud = first.create({ name: 'Cloud', type: 'cloud', target });
  assert.equal(cloud.credential, 'dedicated');
  const task = first.get(cloud.id).store.createTask({ title: 'Offline work', kind: 'manual' });
  await first.close();
  const reopened = manager(t, { dataDir, githubToken: 'must-not-fallback' });
  const runtime = reopened.get(cloud.id);
  assert.equal(runtime.store.snapshot().tasks[0].id, task.id);
  assert.equal(runtime.sync.getStatus().configured, true);
  await assert.rejects(runtime.sync.preview(), /Set FOGGY_SYNC_TOKEN/);
  assert.equal(reopened.update(cloud.id, { name: 'Offline rename' }).name, 'Offline rename');
  assert.throws(
    () => reopened.create({ name: 'No fallback', type: 'cloud', target }),
    /FOGGY_SYNC_TOKEN/,
  );
});

test('manager starts all pollers, starts new workspaces, and stops every runtime', async (t) => {
  const workspaces = manager(t, { dataDir: directory(t) });
  const first = workspaces.get('default');
  const second = workspaces.get(workspaces.create({ name: 'Second', type: 'local' }).id);
  const starts: string[] = [];
  t.mock.method(first.github, 'start', () => {
    starts.push('first');
  });
  t.mock.method(second.github, 'start', () => {
    starts.push('second');
  });
  workspaces.start();
  assert.deepEqual(starts, ['first', 'second']);
  const start = t.mock.method(Object.getPrototypeOf(first.github), 'start', () => {
    starts.push('third');
  });
  const third = workspaces.get(workspaces.create({ name: 'Third', type: 'local' }).id);
  assert.equal(start.mock.callCount(), 1);
  await workspaces.close();
  for (const runtime of [first, second, third]) {
    await assert.rejects(runtime.sync.preview(), /stopped/);
    assert.throws(() => runtime.store.snapshot());
  }
  assert.throws(() => workspaces.get('default'), /stopped/);
});

test('conversion preserves Store, graph and layout, performs no remote requests, and forbids retargeting', async (t) => {
  const dataDir = directory(t);
  const workspaces = manager(t, { dataDir, githubToken: secret });
  const runtime = workspaces.get('default');
  const task = runtime.store.createTask({ title: 'Existing', kind: 'manual' });
  runtime.store.saveLayout({
    viewId: 'root',
    mode: 'manual',
    positions: [{ nodeId: task.id, x: 1, y: 2 }],
  });
  const before = runtime.store.snapshot();
  const oldSync = runtime.sync;
  const cloud = workspaces.update('default', { type: 'cloud', target, credential: 'github' });
  assert.equal(cloud.type, 'cloud');
  assert.equal(workspaces.get('default').store, runtime.store);
  assert.deepEqual(runtime.store.snapshot(), before);
  assert.notEqual(runtime.sync, oldSync);
  assert.deepEqual(runtime.sync.getStatus().target, target);
  await assert.rejects(oldSync.preview(), /stopped/);
  const sync = runtime.sync;
  assert.equal(
    workspaces.update('default', {
      name: 'Renamed cloud',
      type: 'cloud',
      target,
      credential: 'github',
    }).name,
    'Renamed cloud',
  );
  assert.equal(runtime.sync, sync);
  assert.throws(() => workspaces.update('default', { type: 'local' }), /demotion/);
  assert.throws(
    () => workspaces.update('default', { target: { ...target, path: 'other.json' } }),
    /retargeting/,
  );
  assert.throws(
    () => workspaces.update('default', { credential: 'dedicated' }),
    /credential changes/,
  );
  await workspaces.close();
  const reopened = manager(t, { dataDir, githubToken: secret });
  assert.equal(reopened.list().workspaces[0].name, 'Renamed cloud');
  assert.deepEqual(reopened.get('default').store.snapshot(), before);
});

test('strict validation and missing credentials leave registry and graph unchanged', (t) => {
  const workspaces = manager(t, { dataDir: directory(t) });
  const before = workspaces.list();
  for (const input of [
    null,
    [],
    {},
    { name: '', type: 'local' },
    { name: 'x'.repeat(101), type: 'local' },
    { name: 'x', type: 'local', token: secret },
    { name: 'x', type: 'local', target },
    { name: 'x', type: 'cloud', target, credential: null },
    { name: 'x', type: 'cloud', target: { ...target, token: secret }, credential: 'dedicated' },
    { name: 'x', type: 'cloud', target: { ...target, path: '../bad' }, credential: 'dedicated' },
  ])
    assert.throws(() => workspaces.create(input), DomainError);
  for (const credential of ['dedicated', 'github']) {
    assert.throws(
      () => workspaces.create({ name: 'Cloud', type: 'cloud', target, credential }),
      /credential is unavailable/,
    );
    assert.throws(
      () => workspaces.update('default', { type: 'cloud', target, credential }),
      /credential is unavailable/,
    );
  }
  assert.throws(() => workspaces.get('../default'), /not found/);
  assert.throws(() => workspaces.update('missing', { name: 'x' }), /not found/);
  assert.deepEqual(workspaces.list(), before);
});

test('credentials are explicit and sync previews cannot cross workspaces', async (t) => {
  const authorizations: string[] = [];
  const requests: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    requests.push(String(url));
    authorizations.push(new Headers(init?.headers).get('Authorization')!);
    assert.notEqual(init?.method, 'PUT');
    if (String(url).includes('/contents/')) return new Response(null, { status: 404 });
    return Response.json({ private: true });
  };
  const workspaces = manager(t, {
    dataDir: directory(t),
    dedicatedToken: 'dedicated-secret',
    githubToken: 'github-secret',
    fetch: fetcher,
  });
  const a = workspaces.create({ name: 'A', type: 'cloud', target, credential: 'dedicated' });
  const b = workspaces.create({ name: 'B', type: 'cloud', target, credential: 'github' });
  const first = workspaces.get(a.id);
  const second = workspaces.get(b.id);
  assert.notEqual(first.github, second.github);
  assert.notEqual(first.sync, second.sync);
  assert.equal(requests.length, 0);
  const previewA = await first.sync.preview();
  assert.deepEqual(new Set(authorizations), new Set(['Bearer dedicated-secret']));
  authorizations.length = 0;
  const previewB = await second.sync.preview();
  assert.deepEqual(new Set(authorizations), new Set(['Bearer github-secret']));
  const count = requests.length;
  await assert.rejects(second.sync.apply(previewA.previewId), /stale/);
  await assert.rejects(first.sync.apply(previewB.previewId), /stale/);
  assert.equal(requests.length, count);
});
