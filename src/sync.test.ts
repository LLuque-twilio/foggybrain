import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainError, emptyPortableState, Store } from './core.js';
import { readSyncConfig, StateSync } from './sync.js';
import type { PortableState, SyncTarget } from './shared.js';

const target: SyncTarget = { repo: 'owner/repo', branch: 'main', path: 'foggybrain/state.json' };
const token = 'separate-secret-token';
const conflict = (error: unknown) => error instanceof DomainError && error.status === 409;

class Github {
  state: PortableState | null = null;
  revision = 1;
  private = true;
  branchExists = true;
  puts = 0;
  requests: string[] = [];
  duringPut?: () => void;
  failPut: 'before' | 'after' | null = null;
  override?: (url: string, init: RequestInit) => Response | undefined;
  get sha() {
    return this.revision.toString(16).padStart(40, '0');
  }
  edit(change: (state: PortableState) => void) {
    change(this.state!);
    this.revision++;
  }
  fetch: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    this.requests.push(url);
    assert.equal(new URL(url).origin, 'https://api.github.com');
    assert.equal(init.redirect, 'error');
    assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${token}`);
    assert.ok(init.signal);
    const overridden = this.override?.(url, init);
    if (overridden) return overridden;
    if (url.endsWith('/repos/owner/repo')) return Response.json({ private: this.private });
    if (url.includes('/branches/'))
      return Response.json({}, { status: this.branchExists ? 200 : 404 });
    assert.ok(url.includes('/contents/foggybrain/state.json'));
    if (init.method === 'PUT') {
      this.puts++;
      const body = JSON.parse(init.body as string);
      assert.equal(body.branch, target.branch);
      if (this.state ? body.sha !== this.sha : body.sha !== undefined)
        return Response.json({}, { status: 409 });
      if (this.failPut === 'before') throw new Error(`network failure ${token}`);
      this.state = JSON.parse(Buffer.from(body.content, 'base64').toString());
      this.revision++;
      this.duringPut?.();
      if (this.failPut === 'after') throw new Error(`network failure ${token}`);
      return Response.json({ content: { sha: this.sha } });
    }
    if (!this.state) return Response.json({}, { status: 404 });
    const bytes = Buffer.from(JSON.stringify(this.state));
    return Response.json({
      type: 'file',
      encoding: 'base64',
      sha: this.sha,
      size: bytes.length,
      content: bytes.toString('base64'),
      download_url: 'https://evil.example/token-stealer',
    });
  };
}

function setup(t: TestContext, path = ':memory:', github = new Github()) {
  const store = new Store(path);
  const sync = new StateSync(store, { target, token, fetch: github.fetch });
  t.after(async () => {
    await sync.stop();
    store.close();
  });
  return { store, sync, github };
}

async function apply(sync: StateSync) {
  const preview = await sync.preview();
  assert.equal(preview.canApply, true, JSON.stringify(preview));
  return sync.apply(preview.previewId);
}

test('config is explicit, separate from GH_TOKEN, and rejects unsafe targets', () => {
  assert.equal(readSyncConfig({ GH_TOKEN: 'not-sync' }), null);
  assert.equal(readSyncConfig({ FOGGY_SYNC_TOKEN: token }), null);
  assert.deepEqual(readSyncConfig({ FOGGY_SYNC_REPO: 'Owner/Repo' }), target);
  assert.deepEqual(readSyncConfig({ FOGGY_SYNC_REPO: 'Owner/Repo', GH_TOKEN: token }), target);
  for (const invalid of ['', ' ', 'token\n', 'with space', 'non-ascii-\u00e9']) {
    assert.throws(() => readSyncConfig({ FOGGY_SYNC_TOKEN: invalid }), /FOGGY_SYNC_TOKEN/);
    assert.throws(
      () => readSyncConfig({ FOGGY_SYNC_REPO: 'o/r', FOGGY_SYNC_TOKEN: invalid }),
      /FOGGY_SYNC_TOKEN/,
    );
  }
  assert.deepEqual(
    readSyncConfig({ FOGGY_SYNC_REPO: 'Owner/Repo', FOGGY_SYNC_TOKEN: token }),
    target,
  );
  for (const env of [
    { FOGGY_SYNC_BRANCH: 'main' },
    { FOGGY_SYNC_PATH: 'state.json' },
    ...['https://github.com/o/r', 'o/..', 'o/r?q=x', 'o/r/extra'].map((repo) => ({
      FOGGY_SYNC_REPO: repo,
      FOGGY_SYNC_TOKEN: token,
    })),
    ...['../main', 'refs//main', 'main.lock', 'a@{x}', '-main', 'main?x', 'a\\b', 'a/./b'].map(
      (branch) => ({ FOGGY_SYNC_REPO: 'o/r', FOGGY_SYNC_TOKEN: token, FOGGY_SYNC_BRANCH: branch }),
    ),
    ...['/state.json', '../state.json', 'a//b', 'https://evil/x', 'a%2fb', 'a/../b'].map(
      (path) => ({ FOGGY_SYNC_REPO: 'o/r', FOGGY_SYNC_TOKEN: token, FOGGY_SYNC_PATH: path }),
    ),
  ])
    assert.throws(() => readSyncConfig(env), DomainError);
  const store = new Store(':memory:');
  assert.throws(() => new StateSync(store, { target }), /separate sync token/);
  store.close();
});

test('missing file bootstraps only on apply, previews are read-only and one-use', async (t) => {
  const { store, sync, github } = setup(t);
  const task = store.createTask({ title: 'Local', kind: 'manual' });
  const before = store.snapshot();
  const preview = await sync.preview();
  assert.deepEqual(preview.localChanges, []);
  assert.deepEqual(preview.remoteChanges, [
    { collection: 'tasks', id: task.id, title: 'Local', kind: 'added' },
  ]);
  assert.equal(github.puts, 0);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.syncRecord(target).pending, null);
  const status = await sync.apply(preview.previewId);
  assert.equal(status.dirty, false);
  assert.equal(status.syncing, false);
  assert.ok(status.lastSync);
  assert.deepEqual(github.state, store.exportState());
  await assert.rejects(sync.apply(preview.previewId), conflict);
  await apply(sync);
  assert.equal(github.puts, 1);
});

test('empty local imports but two nonempty stores never assume common ancestry', async (t) => {
  const first = setup(t);
  first.store.createTask({ title: 'Remote', kind: 'manual' });
  await apply(first.sync);
  const second = setup(t, ':memory:', first.github);
  const preview = await second.sync.preview();
  assert.equal(preview.localChanges[0].kind, 'added');
  assert.deepEqual(preview.remoteChanges, []);
  await second.sync.apply(preview.previewId);
  assert.equal(first.github.puts, 1);
  const third = setup(t, ':memory:', first.github);
  third.store.createTask({ title: 'Unrelated', kind: 'manual' });
  for (const resolution of [undefined, 'local', 'remote'] as const) {
    const blocked = await third.sync.preview({ resolution });
    assert.equal(blocked.canApply, false);
    assert.match(blocked.validationError!, /No common sync baseline/);
  }
});

test('persistent base merges independent fields and pending local edits across restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'foggy-sync-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite');
  const first = setup(t, path);
  const task = first.store.createTask({ title: 'Base', kind: 'manual' });
  await apply(first.sync);
  await first.sync.stop();
  first.store.close();
  const { store, sync, github } = setup(t, path, first.github);
  assert.equal(sync.getStatus().dirty, false);
  store.updateTask(task.id, { title: 'Local title' });
  github.edit((state) => {
    state.tasks[0].description = 'Remote description';
  });
  const preview = await sync.preview();
  assert.deepEqual(preview.conflicts, []);
  assert.equal(preview.localChanges[0].kind, 'updated');
  assert.equal(preview.remoteChanges[0].kind, 'updated');
  await sync.apply(preview.previewId);
  assert.equal(store.snapshot().tasks[0].title, 'Local title');
  assert.equal(store.snapshot().tasks[0].description, 'Remote description');
  assert.deepEqual(store.exportState(), github.state);
});

test('field conflict resolution preserves nonconflicting edits and regenerates preview IDs', async (t) => {
  const { store, sync, github } = setup(t);
  const task = store.createTask({ title: 'Base', kind: 'manual' });
  await apply(sync);
  store.updateTask(task.id, { title: 'Local' });
  github.edit((state) => {
    state.tasks[0].title = 'Remote';
    state.tasks[0].description = 'Compatible';
  });
  const blocked = await sync.preview();
  assert.equal(blocked.canApply, false);
  assert.deepEqual(blocked.conflicts, [
    { path: `tasks/${task.id}/title`, base: 'Base', local: 'Local', remote: 'Remote' },
  ]);
  await assert.rejects(sync.apply(blocked.previewId), conflict);
  const local = await sync.preview({ resolution: 'local' });
  assert.notEqual(local.previewId, blocked.previewId);
  assert.equal(local.canApply, true);
  const remote = await sync.preview({ resolution: 'remote' });
  assert.equal(remote.canApply, true);
  await assert.rejects(sync.apply(local.previewId), conflict);
  const selected = await sync.preview({ resolution: 'local' });
  await sync.apply(selected.previewId);
  assert.equal(store.snapshot().tasks[0].title, 'Local');
  assert.equal(store.snapshot().tasks[0].description, 'Compatible');
});

test('delete/edit conflicts use null and resolution cannot silently discard dangling edges', async (t) => {
  const { store, sync, github } = setup(t);
  const a = store.createTask({ title: 'A', kind: 'manual' });
  const b = store.createTask({ title: 'B', kind: 'manual' });
  await apply(sync);
  store.deleteTask(a.id);
  github.edit((state) => {
    state.tasks.find((task) => task.id === a.id)!.title = 'Edited';
    state.dependencies.push({ id: 'edge', prerequisiteId: a.id, dependentId: b.id });
  });
  const blocked = await sync.preview();
  assert.equal(blocked.conflicts[0].local, null);
  const local = await sync.preview({ resolution: 'local' });
  assert.equal(local.canApply, false);
  assert.match(local.validationError!, /Task not found/);
  const remote = await sync.preview({ resolution: 'remote' });
  assert.equal(remote.canApply, true);
  await sync.apply(remote.previewId);
  assert.equal(store.snapshot().dependencies.length, 1);
  assert.equal(store.snapshot().tasks.find((task) => task.id === a.id)!.title, 'Edited');
});

test('individually valid changes that combine into an effective cycle are blocked', async (t) => {
  const { store, sync, github } = setup(t);
  const group = store.createTask({ title: 'Group', kind: 'container' });
  const task = store.createTask({ title: 'Task', kind: 'manual' });
  await apply(sync);
  store.addReference(group.id, task.id);
  github.edit((state) => {
    state.dependencies.push({ id: 'edge', prerequisiteId: group.id, dependentId: task.id });
  });
  for (const resolution of [undefined, 'local', 'remote'] as const) {
    const preview = await sync.preview({ resolution });
    assert.deepEqual(preview.conflicts, []);
    assert.equal(preview.canApply, false);
    assert.match(preview.validationError!, /cycle/);
  }
});

for (const deletingSide of ['local', 'remote'] as const) {
  for (const structure of [
    'prerequisite',
    'dependent',
    'incoming reference',
    'outgoing reference',
    'descendants',
    'edited descendant',
  ] as const) {
    test(`${deletingSide} delete/edit resolution cannot lose baseline ${structure}`, async (t) => {
      const { store, sync, github } = setup(t);
      const group = store.createTask({ title: 'B', kind: 'container' });
      const a = store.createTask({ title: 'A', kind: 'manual' });
      let editedId = group.id;
      if (structure === 'prerequisite') store.addDependency(a.id, group.id);
      if (structure === 'dependent') store.addDependency(group.id, a.id);
      if (structure === 'incoming reference') {
        const owner = store.createTask({ title: 'Owner', kind: 'container' });
        store.addReference(owner.id, group.id);
      }
      if (structure === 'outgoing reference') store.addReference(group.id, a.id);
      if (structure === 'descendants' || structure === 'edited descendant') {
        const nested = store.createTask({ title: 'Nested', kind: 'container', parentId: group.id });
        const leaf = store.createTask({ title: 'Leaf', kind: 'manual', parentId: nested.id });
        if (structure === 'edited descendant') editedId = leaf.id;
      }
      await apply(sync);
      const other = setup(t, ':memory:', github);
      await apply(other.sync);
      const deleting = deletingSide === 'local' ? store : other.store;
      const surviving = deletingSide === 'local' ? other.store : store;
      deleting.deleteTask(group.id);
      surviving.updateTask(editedId, { title: 'Edited' });
      github.edit((state) => Object.assign(state, other.store.exportState()));
      const before = store.snapshot();
      const remoteBefore = structuredClone(github.state);
      const survivingSide = deletingSide === 'local' ? 'remote' : 'local';
      const preview = await sync.preview({ resolution: survivingSide });
      assert.equal(preview.canApply, false);
      assert.match(preview.validationError!, /Structural delete\/edit conflict/);
      await assert.rejects(sync.apply(preview.previewId), conflict);
      assert.deepEqual(store.snapshot(), before);
      assert.deepEqual(github.state, remoteBefore);
      const deletion = await sync.preview({ resolution: deletingSide });
      assert.equal(deletion.canApply, true, JSON.stringify(deletion));
    });
  }

  test(`${deletingSide} compatible independent deletions remain applicable with survivor resolution`, async (t) => {
    const { store, sync, github } = setup(t);
    const b = store.createTask({ title: 'B', kind: 'manual' });
    const a = store.createTask({ title: 'A', kind: 'manual' });
    store.addDependency(a.id, b.id);
    const unrelated = store.createTask({ title: 'Unrelated', kind: 'container' });
    store.createTask({ title: 'Child', kind: 'manual', parentId: unrelated.id });
    await apply(sync);
    const other = setup(t, ':memory:', github);
    await apply(other.sync);
    const deleting = deletingSide === 'local' ? store : other.store;
    const surviving = deletingSide === 'local' ? other.store : store;
    deleting.deleteTask(b.id);
    deleting.deleteTask(unrelated.id);
    surviving.updateTask(b.id, { title: 'Edited' });
    surviving.deleteTask(a.id);
    github.edit((state) => Object.assign(state, other.store.exportState()));
    const preview = await sync.preview({
      resolution: deletingSide === 'local' ? 'remote' : 'local',
    });
    assert.equal(preview.canApply, true, JSON.stringify(preview));
    await sync.apply(preview.previewId);
    assert.deepEqual(
      store.snapshot().tasks.map((task) => task.id),
      [b.id],
    );
    assert.equal(store.snapshot().tasks[0].title, 'Edited');
  });
}

for (const status of [409, 422]) {
  test(`definitive PUT ${status} restores baseline so a real remote race re-previews normally`, async (t) => {
    const { store, sync, github } = setup(t);
    const task = store.createTask({ title: 'Base', kind: 'manual' });
    await apply(sync);
    store.updateTask(task.id, { title: 'Local' });
    const previous = store.syncRecord(target);
    const preview = await sync.preview();
    github.override = (_url, init) => {
      if (init.method === 'PUT') {
        github.edit((state) => {
          state.tasks[0].description = 'Racing remote edit';
        });
        store.updateTask(task.id, { title: 'Concurrent local edit' });
        return Response.json({}, { status });
      }
    };
    await assert.rejects(sync.apply(preview.previewId), conflict);
    assert.deepEqual(store.syncRecord(target), previous);
    assert.equal(store.snapshot().tasks[0].title, 'Concurrent local edit');
    github.override = undefined;
    const next = await sync.preview();
    assert.equal(next.canApply, true, JSON.stringify(next));
    assert.deepEqual(next.conflicts, []);
    await sync.apply(next.previewId);
    assert.equal(store.snapshot().tasks[0].description, 'Racing remote edit');
    assert.equal(store.snapshot().tasks[0].title, 'Concurrent local edit');
  });

  test(`definitive PUT ${status} during recovery restores the previous pending intent`, async (t) => {
    const { store, sync, github } = setup(t);
    const task = store.createTask({ title: 'Base', kind: 'manual' });
    await apply(sync);
    store.updateTask(task.id, { title: 'First attempt' });
    github.failPut = 'before';
    await assert.rejects(apply(sync), DomainError);
    const previous = store.syncRecord(target);
    assert.ok(previous.pending);
    github.failPut = null;
    store.updateTask(task.id, { description: 'New local work' });
    github.override = (_url, init) =>
      init.method === 'PUT' ? Response.json({}, { status }) : undefined;
    await assert.rejects(apply(sync), conflict);
    assert.deepEqual(store.syncRecord(target), previous);
    github.override = undefined;
    await apply(sync);
    assert.equal(store.syncRecord(target).pending, null);
    assert.equal(store.snapshot().tasks[0].description, 'New local work');
  });
}

test('a successful PUT status with an unreadable body keeps the upload intent', async (t) => {
  const { store, sync, github } = setup(t);
  store.createTask({ title: 'Local', kind: 'manual' });
  github.override = (_url, init) =>
    init.method === 'PUT'
      ? new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('Response read failed'));
            },
          }),
        )
      : undefined;
  await assert.rejects(apply(sync), DomainError);
  assert.ok(store.syncRecord(target).pending);
});

test('stale local, remote SHA, and a SHA CAS race reject without overwrites', async (t) => {
  const { store, sync, github } = setup(t);
  const task = store.createTask({ title: 'Base', kind: 'manual' });
  await apply(sync);
  let preview = await sync.preview();
  store.updateTask(task.id, { title: 'Changed' });
  await assert.rejects(sync.apply(preview.previewId), conflict);
  preview = await sync.preview();
  github.revision++;
  await assert.rejects(sync.apply(preview.previewId), conflict);
  preview = await sync.preview();
  github.override = (_url, init) => {
    if (init.method === 'PUT') {
      github.revision++;
      return Response.json({}, { status: 409 });
    }
  };
  await assert.rejects(sync.apply(preview.previewId), conflict);
  assert.equal(store.snapshot().tasks[0].title, 'Changed');
  assert.equal(github.state!.tasks[0].title, 'Base');
});

test('concurrent local edits during upload survive and pending reconciliation survives restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'foggy-sync-pending-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite');
  const first = setup(t, path);
  const task = first.store.createTask({ title: 'Base', kind: 'manual' });
  await apply(first.sync);
  first.store.updateTask(task.id, { title: 'Uploaded' });
  first.github.edit((state) => {
    state.tasks[0].description = 'Remote work';
  });
  first.github.duringPut = () => {
    first.store.updateTask(task.id, { title: 'Concurrent' });
  };
  const preview = await first.sync.preview();
  await assert.rejects(first.sync.apply(preview.previewId), conflict);
  assert.equal(first.store.snapshot().tasks[0].title, 'Concurrent');
  assert.equal(first.store.snapshot().tasks[0].description, '');
  assert.ok(first.store.syncRecord(target).pending);
  await first.sync.stop();
  first.store.close();
  first.github.duringPut = undefined;
  const second = setup(t, path, first.github);
  await apply(second.sync);
  assert.equal(second.store.snapshot().tasks[0].title, 'Concurrent');
  assert.equal(second.store.snapshot().tasks[0].description, 'Remote work');
  assert.equal(second.store.syncRecord(target).pending, null);
  assert.equal(second.sync.getStatus().dirty, false);
});

for (const failure of ['before', 'after'] as const)
  test(`ambiguous PUT failure ${failure} commit never retries blindly or leaks token`, async (t) => {
    const { store, sync, github } = setup(t);
    store.createTask({ title: 'Local', kind: 'manual' });
    const before = store.snapshot();
    github.failPut = failure;
    const preview = await sync.preview();
    await assert.rejects(
      sync.apply(preview.previewId),
      (error) => error instanceof DomainError && !error.message.includes(token),
    );
    assert.equal(github.puts, 1);
    assert.deepEqual(store.snapshot(), before);
    assert.ok(store.syncRecord(target).pending);
    await assert.rejects(sync.apply(preview.previewId), conflict);
    github.failPut = null;
    await apply(sync);
    assert.equal(github.puts, failure === 'after' ? 1 : 2);
    assert.equal(sync.getStatus().dirty, false);
  });

test('uncertain upload plus subsequent remote edits blocks reconciliation safely', async (t) => {
  const { store, sync, github } = setup(t);
  store.createTask({ title: 'Local', kind: 'manual' });
  github.failPut = 'after';
  const preview = await sync.preview();
  await assert.rejects(sync.apply(preview.previewId));
  github.edit((state) => {
    state.tasks[0].title = 'Third party edit';
  });
  const blocked = await sync.preview({ resolution: 'local' });
  assert.equal(blocked.canApply, false);
  assert.match(blocked.validationError!, /uncertain upload/);
  assert.equal(github.puts, 1);
});

test('private repository and existing branch are required, even for a missing file', async (t) => {
  const { sync, github } = setup(t);
  github.private = false;
  await assert.rejects(sync.preview(), /private GitHub repository/);
  assert.equal(github.requests.length, 1);
  github.private = true;
  github.branchExists = false;
  await assert.rejects(sync.preview(), DomainError);
  assert.ok(!github.requests.some((url) => url.includes('/contents/')));
  assert.equal(github.puts, 0);
});

test('malformed content, oversized envelopes, foreign response URLs and redirects are rejected', async (t) => {
  const { sync, github } = setup(t);
  for (const content of [
    '{',
    JSON.stringify({ ...emptyPortableState(), layouts: [] }),
    JSON.stringify({ version: 2, tasks: [], dependencies: [], references: [] }),
  ]) {
    github.override = (url) =>
      url.includes('/contents/')
        ? Response.json({
            type: 'file',
            sha: github.sha,
            encoding: 'base64',
            size: Buffer.byteLength(content),
            content: Buffer.from(content).toString('base64'),
          })
        : undefined;
    await assert.rejects(sync.preview(), DomainError);
  }
  for (const response of [
    new Response('x'.repeat(2 * 1024 * 1024 + 1)),
    new Response(null, { status: 302, headers: { location: 'https://evil.example' } }),
    Object.defineProperty(Response.json({ private: true }), 'url', {
      value: 'https://evil.example',
    }),
    Object.defineProperty(Response.json({ private: true }), 'redirected', { value: true }),
    Response.json({
      type: 'file',
      sha: github.sha,
      encoding: 'base64',
      size: 1024 * 1024 + 1,
      content: '',
    }),
  ]) {
    github.override = () => response;
    await assert.rejects(sync.preview(), DomainError);
  }
  github.override = () => {
    throw new Error(`network ${token}`);
  };
  await assert.rejects(
    sync.preview(),
    (error) => error instanceof DomainError && !String(error).includes(token),
  );
  assert.equal(github.puts, 0);
});

test('PR polling and layouts do not dirty state or stale previews; imports preserve only matching PR cache', async (t) => {
  const { store, sync, github } = setup(t);
  const pr = store.createTask({ title: 'PR', kind: 'pr', prUrl: 'https://github.com/o/r/pull/1' });
  await apply(sync);
  const preview = await sync.preview();
  store.updatePr(pr.id, { state: 'merged', checkedAt: '2026-09-08T12:00:00Z', error: null });
  store.saveLayout({ viewId: 'root', mode: 'manual', positions: [{ nodeId: pr.id, x: 1, y: 2 }] });
  assert.equal(sync.getStatus().dirty, false);
  await sync.apply(preview.previewId);
  assert.equal(store.snapshot().tasks[0].prState, 'merged');
  assert.equal(store.snapshot().layouts[0].positions.length, 1);
  assert.ok(!JSON.stringify(github.state).includes('prState'));
  assert.ok(!JSON.stringify(github.state).includes('updatedAt'));
  github.edit((state) => {
    state.tasks[0].prUrl = 'https://github.com/o/r/pull/2';
  });
  await apply(sync);
  assert.equal(store.snapshot().tasks[0].prState, 'unknown');
  assert.equal(store.snapshot().tasks[0].prCheckedAt, null);
  github.edit((state) => {
    state.tasks = [];
  });
  await apply(sync);
  assert.deepEqual(store.snapshot().layouts[0].positions, []);
});

test('stop aborts and awaits in-flight work, and rejects future operations', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let aborted = false;
  const sync = new StateSync(store, {
    target,
    token,
    fetch: async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => {
          aborted = true;
          reject(new Error(token));
        });
        started();
      }),
  });
  const preview = sync.preview();
  const rejected = assert.rejects(preview, DomainError);
  await ready;
  assert.equal(sync.getStatus().syncing, true);
  await assert.rejects(sync.preview(), conflict);
  await sync.stop();
  await rejected;
  assert.equal(aborted, true);
  assert.equal(sync.getStatus().syncing, false);
  await assert.rejects(sync.preview(), /stopped/);
});

test('one 10-second deadline covers the entire operation, including response reads', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new Store(':memory:');
  t.after(() => store.close());
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const sync = new StateSync(store, {
    target,
    token,
    fetch: async (_url, init) => {
      t.mock.timers.tick(6_000);
      return new Response(
        new ReadableStream({
          start(controller) {
            init!.signal!.addEventListener('abort', () => controller.error(new Error(token)));
            started();
          },
        }),
      );
    },
  });
  const preview = sync.preview();
  const rejected = assert.rejects(
    preview,
    (error) => error instanceof DomainError && !String(error).includes(token),
  );
  await ready;
  t.mock.timers.tick(4_000);
  await rejected;
  await sync.stop();
});

test('portable JSON is capped at 1 MB, with bounded base64 decoding near the limit', async (t) => {
  const { store, sync, github } = setup(t);
  const task = store.createTask({ title: 'Large', kind: 'manual' });
  store.updateTask(task.id, { description: 'x'.repeat(1024 * 1024) });
  const blocked = await sync.preview();
  assert.equal(blocked.canApply, false);
  assert.match(blocked.validationError!, /1 MB/);
  store.updateTask(task.id, { description: 'x'.repeat(1024 * 1024 - 1024) });
  await apply(sync);
  assert.equal((await sync.preview()).canApply, true);
  github.edit((state) => {
    state.tasks[0].description += 'x'.repeat(2048);
  });
  await assert.rejects(sync.preview(), /Invalid GitHub state file/);
});

test('sync cleans removed container views and removed shared and owned memberships', async (t) => {
  const { store, sync, github } = setup(t);
  const group = store.createTask({ title: 'Group', kind: 'container' });
  const owned = store.createTask({ title: 'Owned', kind: 'manual', parentId: group.id });
  const shared = store.createTask({ title: 'Shared', kind: 'manual' });
  store.addReference(group.id, shared.id);
  store.saveLayout({
    viewId: group.id,
    mode: 'manual',
    positions: [
      { nodeId: owned.id, x: 1, y: 2 },
      { nodeId: shared.id, x: 3, y: 4 },
    ],
  });
  await apply(sync);
  github.edit((state) => {
    state.tasks.find((task) => task.id === owned.id)!.parentId = null;
    state.references = [];
  });
  await apply(sync);
  assert.deepEqual(store.snapshot().layouts[0].positions, []);
  github.edit((state) => {
    state.tasks = state.tasks.filter((task) => task.id !== group.id);
  });
  await apply(sync);
  assert.deepEqual(store.snapshot().layouts, []);
});
