import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { DomainError, Store, validatePortableState } from './core.js';
import type { TaskView } from './shared.js';

function memory(t: TestContext): Store {
  const store = new Store(':memory:');
  t.after(() => store.close());
  return store;
}

function view(store: Store, task: { id: string }): TaskView {
  return store.snapshot().tasks.find((candidate) => candidate.id === task.id)!;
}

function manual(store: Store, title = 'Step', parentId?: string) {
  return store.createTask({ title, kind: 'manual', parentId });
}

function container(store: Store, title = 'Group', parentId?: string) {
  return store.createTask({ title, kind: 'container', parentId });
}

function rejectsUnchanged(store: Store, action: () => unknown, status = 400) {
  const before = store.snapshot();
  assert.throws(action, (error) => error instanceof DomainError && error.status === status);
  assert.deepEqual(store.snapshot(), before);
}

test('empty store and task defaults; returned values do not mutate storage', (t) => {
  const store = memory(t);
  assert.deepEqual(store.snapshot(), { tasks: [], dependencies: [], references: [], layouts: [] });
  const task = manual(store, '  Write tests  ');
  assert.equal(task.title, 'Write tests');
  assert.equal(task.description, '');
  assert.equal(task.parentId, null);
  assert.equal(task.manualDone, false);
  assert.equal(task.prUrl, null);
  assert.equal(task.prState, 'unknown');
  assert.equal(task.prCheckedAt, null);
  assert.equal(task.prError, null);
  assert.equal(task.status, 'available');
  assert.equal(task.ownSatisfied, false);
  assert.deepEqual(task.waitingOn, []);
  assert.deepEqual(task.childrenIds, []);
  assert.ok(Number.isFinite(Date.parse(task.createdAt)));
  task.title = 'Not persisted';
  const snapshot = store.snapshot();
  snapshot.tasks.length = 0;
  assert.equal(view(store, task).title, 'Write tests');
});

test('early done propagates through a chain immediately when its prerequisite completes', (t) => {
  const store = memory(t);
  const a = manual(store, 'A');
  const b = manual(store, 'B');
  const c = manual(store, 'C');
  store.addDependency(a.id, b.id);
  store.addDependency(b.id, c.id);
  assert.equal(view(store, b).status, 'blocked');
  assert.deepEqual(view(store, c).waitingOn, [b.id]);
  assert.equal(store.setDone(c.id, true).status, 'ready');
  assert.equal(store.setDone(b.id, true).status, 'ready');
  assert.equal(view(store, c).status, 'ready');
  store.setDone(a.id, true);
  assert.deepEqual(
    store.snapshot().tasks.map((task) => task.status),
    ['completed', 'completed', 'completed'],
  );
  store.setDone(a.id, false);
  assert.equal(view(store, a).status, 'available');
  assert.equal(view(store, b).status, 'ready');
  assert.equal(view(store, c).status, 'ready');
  assert.deepEqual(view(store, c).waitingOn, [b.id]);
  store.setDone(c.id, false);
  assert.equal(view(store, c).status, 'blocked');
});

test('diamond graph waits for both branches and accepts shared prerequisites', (t) => {
  const store = memory(t);
  const a = manual(store, 'A');
  const b = manual(store, 'B');
  const c = manual(store, 'C');
  const d = manual(store, 'D');
  store.addDependency(a.id, b.id);
  store.addDependency(a.id, c.id);
  store.addDependency(b.id, d.id);
  store.addDependency(c.id, d.id);
  store.setDone(d.id, true);
  store.setDone(b.id, true);
  store.setDone(a.id, true);
  assert.equal(view(store, b).status, 'completed');
  assert.equal(view(store, d).status, 'ready');
  assert.deepEqual(view(store, d).waitingOn, [c.id]);
  store.setDone(c.id, true);
  assert.equal(view(store, d).status, 'completed');
  store.setDone(a.id, false);
  assert.deepEqual(view(store, d).waitingOn, [b.id, c.id]);
  assert.equal(view(store, d).status, 'ready');
});

test('independent chains do not gate each other', (t) => {
  const store = memory(t);
  const a = manual(store, 'A');
  const b = manual(store, 'B');
  const x = manual(store, 'X');
  const y = manual(store, 'Y');
  store.addDependency(a.id, b.id);
  store.addDependency(x.id, y.id);
  store.setDone(y.id, true);
  store.setDone(a.id, true);
  store.setDone(b.id, true);
  assert.equal(view(store, b).status, 'completed');
  assert.equal(view(store, x).status, 'available');
  assert.equal(view(store, y).status, 'ready');
  store.setDone(x.id, true);
  store.setDone(a.id, false);
  assert.equal(view(store, b).status, 'ready');
  assert.equal(view(store, y).status, 'completed');
});

test('containers require every child including floating children and reject manual completion', (t) => {
  const store = memory(t);
  const group = container(store);
  assert.equal(group.status, 'available');
  assert.equal(group.ownSatisfied, false);
  const a = manual(store, 'A', group.id);
  const b = manual(store, 'B', group.id);
  const floating = manual(store, 'No edges', group.id);
  store.addDependency(a.id, b.id);
  store.setDone(a.id, true);
  store.setDone(b.id, true);
  assert.equal(view(store, group).status, 'available');
  assert.deepEqual(view(store, group).childrenIds, [a.id, b.id, floating.id]);
  store.setDone(floating.id, true);
  assert.equal(view(store, group).status, 'completed');
  store.setDone(a.id, false);
  assert.equal(view(store, group).ownSatisfied, false);
  rejectsUnchanged(store, () => store.setDone(group.id, true));
});

test('container own satisfaction can be ready behind an external prerequisite', (t) => {
  const store = memory(t);
  const group = container(store);
  const child = manual(store, 'Child', group.id);
  const prerequisite = manual(store, 'Gate');
  const dependent = manual(store, 'Next');
  store.addDependency(prerequisite.id, group.id);
  store.addDependency(group.id, dependent.id);
  store.setDone(dependent.id, true);
  assert.equal(view(store, group).status, 'blocked');
  store.setDone(child.id, true);
  assert.equal(view(store, group).status, 'ready');
  assert.equal(view(store, group).ownSatisfied, true);
  assert.deepEqual(view(store, group).waitingOn, [prerequisite.id]);
  store.setDone(prerequisite.id, true);
  assert.equal(view(store, group).status, 'completed');
  assert.equal(view(store, dependent).status, 'completed');
  store.setDone(prerequisite.id, false);
  assert.equal(view(store, group).status, 'ready');
  assert.equal(view(store, dependent).status, 'ready');
});

test('nested references share live tasks across a diamond and reopening propagates', (t) => {
  const store = memory(t);
  const outer = container(store, 'Outer');
  const left = container(store, 'Left', outer.id);
  const right = container(store, 'Right', outer.id);
  const target = container(store, 'Independent target');
  const step = manual(store, 'Shared step', target.id);
  store.addReference(left.id, target.id);
  store.addReference(right.id, target.id);
  const independent = manual(store, 'Independent step');
  store.addReference(outer.id, independent.id);
  store.setDone(step.id, true);
  assert.equal(view(store, left).status, 'completed');
  assert.equal(view(store, right).status, 'completed');
  assert.equal(view(store, outer).status, 'available');
  store.setDone(independent.id, true);
  assert.equal(view(store, outer).status, 'completed');
  store.setDone(step.id, false);
  for (const task of [outer, left, right, target])
    assert.equal(view(store, task).status, 'available');
  assert.equal(view(store, target).parentId, null);
  assert.equal(view(store, step).parentId, target.id);
});

test('references may reuse a task owned by another container without copying or moving it', (t) => {
  const store = memory(t);
  const owner = container(store, 'Owner');
  const other = container(store, 'Other');
  const child = manual(store, 'Child', owner.id);
  const reference = store.addReference(other.id, child.id);
  store.setDone(child.id, true);
  assert.equal(view(store, owner).status, 'completed');
  assert.equal(view(store, other).status, 'completed');
  store.saveLayout({
    viewId: other.id,
    mode: 'manual',
    positions: [{ nodeId: child.id, x: 10, y: 20 }],
  });
  store.removeReference(reference.id);
  assert.equal(view(store, owner).status, 'completed');
  assert.equal(view(store, other).status, 'available');
  assert.equal(view(store, child).parentId, owner.id);
  assert.deepEqual(store.snapshot().layouts[0].positions, []);
});

test('adding unfinished owned or referenced children reopens a completed container and downstream work', (t) => {
  const store = memory(t);
  const group = container(store);
  const first = manual(store, 'First', group.id);
  const next = manual(store, 'Next');
  store.addDependency(group.id, next.id);
  store.setDone(first.id, true);
  store.setDone(next.id, true);
  assert.equal(view(store, next).status, 'completed');
  const added = manual(store, 'Added', group.id);
  assert.equal(view(store, group).status, 'available');
  assert.equal(view(store, next).status, 'ready');
  store.setDone(added.id, true);
  assert.equal(view(store, next).status, 'completed');
  const referenced = manual(store, 'Referenced');
  const reference = store.addReference(group.id, referenced.id);
  assert.equal(view(store, group).status, 'available');
  assert.equal(view(store, next).status, 'ready');
  store.removeReference(reference.id);
  assert.equal(view(store, next).status, 'completed');
  assert.equal(view(store, referenced).status, 'available');
});

test('dependency removals derive completion and duplicate edges are rejected atomically', (t) => {
  const store = memory(t);
  const a = manual(store, 'A');
  const b = manual(store, 'B');
  store.setDone(b.id, true);
  const edge = store.addDependency(a.id, b.id);
  assert.equal(view(store, b).status, 'ready');
  rejectsUnchanged(store, () => store.addDependency(a.id, b.id), 409);
  store.removeDependency(edge.id);
  assert.equal(view(store, b).status, 'completed');
  rejectsUnchanged(store, () => store.removeDependency(edge.id), 404);
});

test('rejects dependency self cycles and multi-hop cycles', (t) => {
  const store = memory(t);
  const a = manual(store, 'A');
  const b = manual(store, 'B');
  const c = manual(store, 'C');
  rejectsUnchanged(store, () => store.addDependency(a.id, a.id), 409);
  store.addDependency(a.id, b.id);
  store.addDependency(b.id, c.id);
  rejectsUnchanged(store, () => store.addDependency(c.id, a.id), 409);
  store.setDone(a.id, true);
  assert.equal(view(store, b).status, 'available');
});

test('rejects containment cycles through dependencies, but allows redundant acyclic requirements', (t) => {
  const store = memory(t);
  const outer = container(store, 'Outer');
  const inner = container(store, 'Inner', outer.id);
  const leaf = manual(store, 'Leaf', inner.id);
  rejectsUnchanged(store, () => store.addDependency(outer.id, leaf.id), 409);
  rejectsUnchanged(store, () => store.addDependency(inner.id, leaf.id), 409);
  store.addDependency(leaf.id, inner.id);
  store.setDone(leaf.id, true);
  assert.equal(view(store, outer).status, 'completed');
});

test('rejects duplicate membership, self references, and nested ancestor references', (t) => {
  const store = memory(t);
  const outer = container(store, 'Outer');
  const inner = container(store, 'Inner', outer.id);
  const target = manual(store);
  rejectsUnchanged(store, () => store.addReference(outer.id, inner.id), 409);
  rejectsUnchanged(store, () => store.addReference(inner.id, inner.id), 409);
  rejectsUnchanged(store, () => store.addReference(inner.id, outer.id), 409);
  store.addReference(inner.id, target.id);
  rejectsUnchanged(store, () => store.addReference(inner.id, target.id), 409);
});

test('rejects hidden cycles mixing nested ownership, references, and dependencies in either insertion order', (t) => {
  const store = memory(t);
  const outer = container(store, 'Outer');
  const inner = container(store, 'Inner', outer.id);
  const referenced = container(store, 'Referenced');
  const leaf = manual(store, 'Leaf', referenced.id);
  const bridge = manual(store, 'Bridge');
  store.addReference(inner.id, referenced.id);
  store.addDependency(outer.id, bridge.id);
  rejectsUnchanged(store, () => store.addDependency(bridge.id, leaf.id), 409);

  const another = container(store, 'Another');
  const gate = manual(store, 'Gate');
  store.addDependency(another.id, gate.id);
  store.addDependency(gate.id, leaf.id);
  rejectsUnchanged(store, () => store.addReference(another.id, outer.id), 409);
  rejectsUnchanged(store, () => store.addReference(referenced.id, outer.id), 409);
});

test('deletion preview includes transitive dependents, owners, and referencing ancestors only', (t) => {
  const store = memory(t);
  const owner = container(store, 'Owner');
  const doomed = container(store, 'Doomed', owner.id);
  const leaf = manual(store, 'Leaf', doomed.id);
  const external = manual(store, 'External');
  const externalNext = manual(store, 'External next');
  const referenceParent = container(store, 'Reference parent');
  const referenceGroup = container(store, 'Reference group', referenceParent.id);
  const independentTarget = container(store, 'Independent reference target');
  const independentLeaf = manual(store, 'Independent leaf', independentTarget.id);
  const unrelated = manual(store, 'Unrelated');
  const edge = store.addDependency(leaf.id, external.id);
  store.addDependency(external.id, externalNext.id);
  const incoming = store.addReference(referenceGroup.id, doomed.id);
  const outgoing = store.addReference(doomed.id, independentTarget.id);
  const before = store.snapshot();
  const preview = store.previewDeletion(doomed.id);
  assert.deepEqual(new Set(preview.taskIds), new Set([doomed.id, leaf.id]));
  assert.deepEqual(
    new Set(preview.affectedTasks.map((task) => task.id)),
    new Set([owner.id, external.id, externalNext.id, referenceGroup.id, referenceParent.id]),
  );
  assert.deepEqual(preview.removedDependencies, [edge]);
  assert.deepEqual(preview.removedReferences, [incoming, outgoing]);
  assert.deepEqual(store.snapshot(), before);
  assert.ok(
    !preview.affectedTasks.some((task) =>
      [independentTarget.id, independentLeaf.id, unrelated.id].includes(task.id),
    ),
  );
});

test('deleting a referenced container deletes owned descendants, preserves nested reference targets, and cleans layout', (t) => {
  const store = memory(t);
  const doomed = container(store, 'Doomed');
  const nested = container(store, 'Nested', doomed.id);
  const leaf = manual(store, 'Leaf', nested.id);
  const independent = container(store, 'Independent');
  const independentLeaf = manual(store, 'Independent leaf', independent.id);
  const observer = container(store, 'Observer');
  const survivor = manual(store, 'Survivor');
  store.addReference(nested.id, independent.id);
  store.addReference(observer.id, doomed.id);
  store.addReference(observer.id, survivor.id);
  store.addDependency(leaf.id, survivor.id);
  const retained = store.addDependency(independentLeaf.id, survivor.id);
  store.setDone(independentLeaf.id, true);
  store.setDone(survivor.id, true);
  assert.equal(view(store, survivor).status, 'ready');
  store.saveLayout({
    viewId: 'root',
    mode: 'manual',
    positions: [
      { nodeId: doomed.id, x: 1, y: 2 },
      { nodeId: independent.id, x: 3, y: 4 },
    ],
  });
  store.saveLayout({ viewId: doomed.id, mode: 'auto', positions: [] });
  store.saveLayout({ viewId: nested.id, mode: 'auto', positions: [] });
  store.saveLayout({
    viewId: observer.id,
    mode: 'manual',
    positions: [
      { nodeId: doomed.id, x: 1, y: 2 },
      { nodeId: survivor.id, x: 3, y: 4 },
    ],
  });
  assert.deepEqual(new Set(store.deleteTask(doomed.id)), new Set([doomed.id, nested.id, leaf.id]));
  const snapshot = store.snapshot();
  assert.deepEqual(
    new Set(snapshot.tasks.map((task) => task.id)),
    new Set([independent.id, independentLeaf.id, observer.id, survivor.id]),
  );
  assert.deepEqual(snapshot.dependencies, [retained]);
  assert.deepEqual(
    snapshot.references.map((ref) => ref.taskId),
    [survivor.id],
  );
  assert.equal(view(store, independent).status, 'completed');
  assert.equal(view(store, survivor).status, 'completed');
  assert.equal(view(store, observer).status, 'completed');
  assert.deepEqual(
    snapshot.layouts.map((layout) => layout.viewId),
    ['root', observer.id],
  );
  assert.deepEqual(
    snapshot.layouts.map((layout) => layout.positions.map((position) => position.nodeId)),
    [[independent.id], [survivor.id]],
  );
});

test('deleting the last child reopens its owner and all consumers', (t) => {
  const store = memory(t);
  const owner = container(store);
  const child = manual(store, 'Child', owner.id);
  const next = manual(store, 'Next');
  store.addDependency(owner.id, next.id);
  store.setDone(child.id, true);
  store.setDone(next.id, true);
  assert.equal(view(store, next).status, 'completed');
  assert.deepEqual(
    new Set(store.previewDeletion(child.id).affectedTasks.map((task) => task.id)),
    new Set([owner.id, next.id]),
  );
  store.deleteTask(child.id);
  assert.equal(view(store, owner).status, 'available');
  assert.equal(view(store, next).status, 'ready');
});

test('PR URLs normalize identity and URL changes reset verification and reopen consumers', (t) => {
  const store = memory(t);
  const owner = container(store);
  const pr = store.createTask({
    kind: 'pr',
    title: 'PR',
    parentId: owner.id,
    prUrl: '  https://GITHUB.COM/Owner/Repo/pull/00042/?tab=files#discussion  ',
  });
  assert.equal(pr.prUrl, 'https://github.com/owner/repo/pull/42');
  const next = manual(store, 'Next');
  store.addDependency(owner.id, next.id);
  store.setDone(next.id, true);
  const checkedAt = '2026-09-08T12:00:00.000Z';
  store.updatePr(pr.id, { state: 'merged', checkedAt, error: null });
  assert.equal(view(store, next).status, 'completed');
  store.updateTask(pr.id, {
    title: 'Renamed',
    description: 'Details',
    prUrl: 'https://github.com/OWNER/REPO/pull/42/',
  });
  assert.equal(view(store, pr).prState, 'merged');
  assert.equal(view(store, pr).prCheckedAt, checkedAt);
  store.updateTask(pr.id, { prUrl: 'https://github.com/owner/repo/pull/43' });
  assert.equal(view(store, pr).prState, 'unknown');
  assert.equal(view(store, pr).prCheckedAt, null);
  assert.equal(view(store, pr).prError, null);
  assert.equal(view(store, pr).status, 'available');
  assert.equal(view(store, owner).status, 'available');
  assert.equal(view(store, next).status, 'ready');
});

test('PR poll errors retain last verified state, successes clear error, and only merged satisfies', (t) => {
  const store = memory(t);
  const pr = store.createTask({ kind: 'pr', title: 'PR', prUrl: 'https://github.com/o/r/pull/1' });
  const checkedAt = '2026-09-08T12:00:00Z';
  for (const state of ['unknown', 'open', 'closed'] as const) {
    assert.equal(store.updatePr(pr.id, { state, checkedAt, error: null }).status, 'available');
  }
  assert.equal(
    store.updatePr(pr.id, { state: 'merged', checkedAt, error: null }).status,
    'completed',
  );
  const failed = store.updatePr(pr.id, {
    checkedAt: '2026-09-08T13:00:00Z',
    error: 'Rate limited',
  });
  assert.equal(failed.prState, 'merged');
  assert.equal(failed.status, 'completed');
  assert.equal(failed.prError, 'Rate limited');
  assert.equal(failed.prCheckedAt, '2026-09-08T13:00:00Z');
  assert.equal(
    store.updatePr(pr.id, { state: 'open', checkedAt, error: 'Network failed' }).prState,
    'merged',
  );
  assert.equal(store.updatePr(pr.id, { checkedAt, error: null }).prState, 'merged');
  assert.equal(view(store, pr).prError, null);
  assert.equal(
    store.updatePr(pr.id, { state: 'closed', checkedAt, error: null }).status,
    'available',
  );
  rejectsUnchanged(store, () => store.setDone(pr.id, true));
});

test('merged PRs may be ready and reopen through prerequisites', (t) => {
  const store = memory(t);
  const gate = manual(store);
  const pr = store.createTask({ title: 'PR', kind: 'pr', prUrl: 'https://github.com/o/r/pull/1' });
  store.addDependency(gate.id, pr.id);
  assert.equal(
    store.updatePr(pr.id, { state: 'merged', checkedAt: '2026-09-08T12:00:00Z', error: null })
      .status,
    'ready',
  );
  store.setDone(gate.id, true);
  assert.equal(view(store, pr).status, 'completed');
  store.setDone(gate.id, false);
  assert.equal(view(store, pr).status, 'ready');
});

test('invalid task inputs and partial updates leave the store unchanged', (t) => {
  const store = memory(t);
  const task = manual(store);
  const invalid = [
    null,
    [],
    'task',
    {},
    { title: ' ', kind: 'manual' },
    { title: 1, kind: 'manual' },
    { title: 'X', kind: 'other' },
    { title: 'X', kind: 'manual', description: null },
    { title: 'X', kind: 'manual', parentId: 1 },
    { title: 'X', kind: 'manual', parentId: task.id },
    { title: 'X', kind: 'pr' },
    { title: 'X', kind: 'manual', prUrl: 'https://github.com/o/r/pull/1' },
    { title: 'X', kind: 'manual', manualDone: true },
  ];
  for (const input of invalid) rejectsUnchanged(store, () => store.createTask(input as never));
  for (const input of [
    null,
    [],
    {},
    { title: '' },
    { title: undefined },
    { description: 1 },
    { kind: 'container' },
    { parentId: null },
    { prUrl: 'https://github.com/o/r/pull/1' },
    { title: 'Would partially change', description: null },
  ]) {
    rejectsUnchanged(store, () => store.updateTask(task.id, input as never));
  }
  for (const done of [undefined, null, 1, 'true', {}])
    rejectsUnchanged(store, () => store.setDone(task.id, done as never));
  assert.equal(store.updateTask(task.id, { description: '' }).description, '');
});

test('invalid GitHub URLs are rejected on create and update without changing verification', (t) => {
  const store = memory(t);
  const pr = store.createTask({ title: 'PR', kind: 'pr', prUrl: 'https://github.com/o/r/pull/1' });
  store.updatePr(pr.id, { state: 'merged', checkedAt: '2026-09-08T12:00:00Z', error: null });
  for (const prUrl of [
    null,
    42,
    '',
    'not a url',
    'http://github.com/o/r/pull/1',
    'https://example.com/o/r/pull/1',
    'https://github.com.evil.test/o/r/pull/1',
    'https://user:secret@github.com/o/r/pull/1',
    'https://github.com:444/o/r/pull/1',
    'https://github.com/o/r/issues/1',
    'https://github.com/o/r/pull/0',
    'https://github.com/o/r/pull/-1',
    'https://github.com/o/r/pull/1/files',
    'https://github.com/o/r/pull/1.5',
    'https://github.com/o/r/pull/1e3',
    'https://github.com/o/r/pull/9007199254740992',
    'https:github.com/o/r/pull/1',
    'https:////github.com/o/r/pull/1',
    'https://github.com/o/other/../r/pull/1',
    'https://github.com/o/r/pull/1\n2',
    'https://github.com/o/r/pull/1\\',
  ]) {
    rejectsUnchanged(store, () => store.createTask({ title: 'Bad', kind: 'pr', prUrl } as never));
    rejectsUnchanged(store, () => store.updateTask(pr.id, { title: 'Bad update', prUrl } as never));
  }
});

test('unknown IDs and invalid memberships report domain errors', (t) => {
  const store = memory(t);
  const task = manual(store);
  const group = container(store);
  for (const action of [
    () => store.updateTask('missing', { title: 'X' }),
    () => store.setDone('missing', true),
    () => store.previewDeletion('missing'),
    () => store.deleteTask('missing'),
    () => store.addDependency('missing', task.id),
    () => store.addDependency(task.id, 'missing'),
    () => store.addReference('missing', task.id),
    () => store.addReference(group.id, 'missing'),
    () => store.removeReference('missing'),
    () => store.removeDependency('missing'),
    () => store.createTask({ title: 'X', kind: 'manual', parentId: 'missing' }),
  ]) {
    rejectsUnchanged(store, action, 404);
  }
  rejectsUnchanged(store, () => store.addReference(task.id, group.id));
  for (const id of ['', null, 1, {}, []]) {
    rejectsUnchanged(store, () => store.deleteTask(id as never));
    rejectsUnchanged(store, () => store.previewDeletion(id as never));
    rejectsUnchanged(store, () => store.addDependency(id as never, task.id));
    rejectsUnchanged(store, () => store.removeReference(id as never));
  }
});

test('PR updates validate shape, states, timestamps, errors, and task kind atomically', (t) => {
  const store = memory(t);
  const pr = store.createTask({ title: 'PR', kind: 'pr', prUrl: 'https://github.com/o/r/pull/1' });
  const checkedAt = '2026-09-08T12:00:00Z';
  for (const input of [
    null,
    [],
    {},
    { checkedAt, error: null, state: 'done' },
    { checkedAt: 'not a date', error: null },
    { checkedAt: 123, error: null },
    { checkedAt, error: 123 },
    { checkedAt },
    { checkedAt, error: null, token: 'secret' },
  ]) {
    rejectsUnchanged(store, () => store.updatePr(pr.id, input as never));
  }
  const step = manual(store);
  rejectsUnchanged(store, () =>
    store.updatePr(step.id, { state: 'merged', checkedAt, error: null }),
  );
});

test('layouts validate shape and finite coordinates and upsert without retaining caller objects', (t) => {
  const store = memory(t);
  const task = manual(store);
  const group = container(store);
  const input = {
    viewId: 'root',
    mode: 'manual' as const,
    positions: [{ nodeId: task.id, x: -12.5, y: 42 }],
  };
  const saved = store.saveLayout(input);
  input.positions[0].x = 999;
  saved.positions[0].y = 999;
  assert.deepEqual(store.snapshot().layouts[0].positions, [{ nodeId: task.id, x: -12.5, y: 42 }]);
  store.saveLayout({ viewId: 'root', mode: 'auto', positions: [] });
  store.saveLayout({ viewId: group.id, mode: 'manual', positions: [] });
  assert.equal(store.snapshot().layouts.length, 2);
  for (const layout of [
    null,
    [],
    {},
    { viewId: 'root', mode: 'bad', positions: [] },
    { viewId: task.id, mode: 'auto', positions: [] },
    { viewId: 'root', mode: 'auto', positions: {} },
    ...[NaN, Infinity, -Infinity, '1', null].map((x) => ({
      viewId: 'root',
      mode: 'manual',
      positions: [{ nodeId: task.id, x, y: 0 }],
    })),
    { viewId: 'root', mode: 'manual', positions: [null] },
    { viewId: 'root', mode: 'manual', positions: new Array(1) },
    {
      viewId: 'root',
      mode: 'manual',
      positions: [
        { nodeId: task.id, x: 0, y: 0 },
        { nodeId: task.id, x: 1, y: 1 },
      ],
    },
  ]) {
    rejectsUnchanged(store, () => store.saveLayout(layout as never));
  }
  rejectsUnchanged(
    store,
    () => store.saveLayout({ viewId: 'missing', mode: 'auto', positions: [] }),
    404,
  );
  rejectsUnchanged(
    store,
    () =>
      store.saveLayout({
        viewId: 'root',
        mode: 'auto',
        positions: [{ nodeId: 'missing', x: 0, y: 0 }],
      }),
    404,
  );
});

test('SQLite disk persistence includes graph, PR verification, layouts, and reopening after restart', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'foggybrain-core-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'nested', 'brain.sqlite');
  const first = new Store(path);
  t.after(() => first.close());
  const owner = container(first);
  const child = manual(first, 'Child', owner.id);
  const pr = first.createTask({ kind: 'pr', title: 'PR', prUrl: 'https://github.com/o/r/pull/1' });
  first.addReference(owner.id, pr.id);
  first.addDependency(child.id, pr.id);
  first.setDone(child.id, true);
  first.updatePr(pr.id, { state: 'merged', checkedAt: '2026-09-08T12:00:00Z', error: null });
  first.saveLayout({
    viewId: owner.id,
    mode: 'manual',
    positions: [{ nodeId: child.id, x: 50, y: 100 }],
  });
  const expected = first.snapshot();
  first.close();
  first.close();
  const second = new Store(path);
  t.after(() => second.close());
  assert.deepEqual(second.snapshot(), expected);
  second.setDone(child.id, false);
  assert.equal(view(second, pr).status, 'ready');
  assert.equal(view(second, owner).status, 'available');
  second.deleteTask(owner.id);
  assert.deepEqual(
    second.snapshot().tasks.map((task) => task.id),
    [pr.id],
  );
  assert.equal(view(second, pr).status, 'completed');
  const deleted = second.snapshot();
  second.close();
  const third = new Store(path);
  t.after(() => third.close());
  assert.deepEqual(third.snapshot(), deleted);
});

test('multiple stores see latest committed writes and never overwrite another instance snapshot', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'foggybrain-core-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'brain.sqlite');
  const first = new Store(path);
  const second = new Store(path);
  t.after(() => {
    first.close();
    second.close();
  });
  const a = manual(first, 'A');
  const b = manual(second, 'B');
  first.addDependency(a.id, b.id);
  second.setDone(b.id, true);
  first.setDone(a.id, true);
  assert.deepEqual(first.snapshot(), second.snapshot());
  assert.equal(view(second, b).status, 'completed');
  rejectsUnchanged(first, () => first.addDependency(b.id, a.id), 409);
  assert.deepEqual(first.snapshot(), second.snapshot());
});

test('a SQLite write failure rolls back all changes and leaves the store usable', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'foggybrain-core-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'brain.sqlite');
  const store = new Store(path);
  const db = new DatabaseSync(path);
  t.after(() => {
    store.close();
    db.close();
  });
  const task = manual(store);
  const before = store.snapshot();
  db.exec(
    "CREATE TRIGGER fail_write BEFORE UPDATE ON foggybrain_snapshot BEGIN SELECT RAISE(ABORT, 'Simulated disk failure'); END",
  );
  assert.throws(() => store.setDone(task.id, true), /Simulated disk failure/);
  assert.deepEqual(store.snapshot(), before);
  db.exec('DROP TRIGGER fail_write');
  assert.equal(store.setDone(task.id, true).status, 'completed');
});

test('portable state validates exact shapes, IDs, memberships and graph before import', (t) => {
  const store = memory(t);
  const group = container(store);
  const child = manual(store, 'Child', group.id);
  const state = store.exportState();
  assert.deepEqual(validatePortableState(state), state);
  const invalid: unknown[] = [
    null,
    [],
    {},
    { ...state, version: 2 },
    { ...state, layouts: [] },
    { ...state, references: null },
  ];
  for (const change of [
    (s: typeof state) => {
      s.tasks.push(s.tasks[0]);
    },
    (s: typeof state) => {
      s.tasks[0].id = '../unsafe';
    },
    (s: typeof state) => {
      s.tasks[0].id = 'root';
    },
    (s: typeof state) => {
      s.tasks[0].parentId = 'missing';
    },
    (s: typeof state) => {
      s.tasks[0].title = ' ';
    },
    (s: typeof state) => {
      (s.tasks[0] as unknown as Record<string, unknown>).prState = 'merged';
    },
    (s: typeof state) => {
      delete (s.tasks[0] as Partial<typeof child>).description;
    },
    (s: typeof state) => {
      s.tasks.find((task) => task.id === group.id)!.manualDone = true;
    },
    (s: typeof state) => {
      s.tasks[0].prUrl = 'https://github.com/o/r/pull/1';
    },
    (s: typeof state) => {
      s.references.push({ id: 'ref', containerId: group.id, taskId: child.id });
    },
    (s: typeof state) => {
      s.references.push({ id: 'ref', containerId: child.id, taskId: group.id });
    },
    (s: typeof state) => {
      s.dependencies.push({ id: 'edge', prerequisiteId: 'missing', dependentId: child.id });
    },
    (s: typeof state) => {
      s.dependencies.push({ id: 'edge', prerequisiteId: group.id, dependentId: child.id });
    },
    (s: typeof state) => {
      s.dependencies.push(
        { id: 'a', prerequisiteId: child.id, dependentId: group.id },
        { id: 'b', prerequisiteId: child.id, dependentId: group.id },
      );
    },
  ]) {
    const copy = structuredClone(state);
    change(copy);
    invalid.push(copy);
  }
  for (const value of invalid) assert.throws(() => validatePortableState(value), DomainError);
  assert.deepEqual(store.exportState(), state);
});

test('sync SQLite backups retain full pre-apply snapshots and baseline updates are atomic', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'foggybrain-backups-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'brain.sqlite');
  const store = new Store(path);
  const db = new DatabaseSync(path);
  t.after(() => {
    store.close();
    db.close();
  });
  const target = { repo: 'o/r', branch: 'main', path: 'state.json' };
  const pr = store.createTask({ title: 'PR', kind: 'pr', prUrl: 'https://github.com/o/r/pull/1' });
  store.updatePr(pr.id, { state: 'merged', checkedAt: '2026-09-08T12:00:00Z', error: null });
  store.saveLayout({ viewId: 'root', mode: 'manual', positions: [{ nodeId: pr.id, x: 1, y: 2 }] });
  const before = store.snapshot();
  const local = store.exportState();
  const merged = structuredClone(local);
  merged.tasks[0].title = 'Imported title';
  merged.tasks.push({ ...merged.tasks[0], id: 'new-pr' });
  const record = store.prepareSync(target, store.syncRecord(target), local, merged, null);
  assert.deepEqual(store.snapshot(), before);
  const backup = JSON.parse(
    db.prepare('SELECT payload FROM foggybrain_sync_backups ORDER BY id LIMIT 1').get()!
      .payload as string,
  );
  const full = {
    ...before,
    tasks: before.tasks.map(
      ({
        status: _status,
        ownSatisfied: _own,
        waitingOn: _waiting,
        childrenIds: _children,
        ...task
      }) => task,
    ),
  };
  assert.deepEqual(backup, full);
  db.exec(
    "CREATE TRIGGER fail_sync BEFORE UPDATE ON foggybrain_snapshot BEGIN SELECT RAISE(ABORT, 'disk failure'); END",
  );
  assert.throws(() => store.finishSync(target, record), /disk failure/);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(store.syncRecord(target), record);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM foggybrain_sync_backups').get()!.count, 1);
  db.exec('DROP TRIGGER fail_sync');
  store.finishSync(target, record);
  assert.deepEqual(store.syncRecord(target).base, validatePortableState(merged));
  assert.equal(store.snapshot().tasks.find((task) => task.id === pr.id)!.prState, 'merged');
  assert.equal(store.snapshot().tasks.find((task) => task.id === 'new-pr')!.prState, 'unknown');
  assert.deepEqual(store.snapshot().layouts, before.layouts);
  store.close();
  const restarted = new Store(path);
  assert.deepEqual(restarted.syncRecord(target).base, validatePortableState(merged));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM foggybrain_sync_backups').get()!.count, 2);
  restarted.close();
});

test('sync optimistic storage check does not clobber concurrent graph changes or baseline changes', (t) => {
  const store = memory(t);
  const task = manual(store);
  const target = { repo: 'o/r', branch: 'main', path: 'state.json' };
  const local = store.exportState();
  const emptyRecord = store.syncRecord(target);
  const pending = store.prepareSync(target, emptyRecord, local, local, null);
  assert.throws(
    () => store.prepareSync(target, emptyRecord, local, local, null),
    (error) => error instanceof DomainError && error.status === 409,
  );
  store.updateTask(task.id, { title: 'Concurrent' });
  rejectsUnchanged(store, () => store.finishSync(target, pending), 409);
  assert.deepEqual(store.syncRecord(target), pending);
});

test('rejected sync rollback conditionally restores only its own record without touching the graph', (t) => {
  const store = memory(t);
  const task = manual(store);
  const target = { repo: 'o/r', branch: 'main', path: 'state.json' };
  const local = store.exportState();
  const previous = store.syncRecord(target);
  const first = store.prepareSync(target, previous, local, local, null);
  store.updateTask(task.id, { title: 'Concurrent' });
  const changed = store.exportState();
  const second = store.prepareSync(target, first, changed, changed, null);
  const snapshot = store.snapshot();
  store.restoreSyncRecord(target, first, previous);
  assert.deepEqual(store.syncRecord(target), second);
  assert.deepEqual(store.snapshot(), snapshot);
  store.restoreSyncRecord(target, second, first);
  assert.deepEqual(store.syncRecord(target), first);
  assert.deepEqual(store.snapshot(), snapshot);
  store.restoreSyncRecord(target, first, previous);
  assert.deepEqual(store.syncRecord(target), previous);
});
