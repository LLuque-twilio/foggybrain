import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ConnectTaskInput,
  CreateTaskInput,
  DeletionPreview,
  Dependency,
  Layout,
  PrMergeStatus,
  PrState,
  PortableState,
  Snapshot,
  SyncTarget,
  Task,
  TaskReference,
  TaskView,
  UpdateTaskInput,
} from './shared.js';

export class DomainError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

interface StoredSnapshot {
  tasks: Task[];
  dependencies: Dependency[];
  references: TaskReference[];
  layouts: Layout[];
}

function objectInput(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainError('Expected an object');
  }
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new DomainError('Unexpected input field');
  }
}

function text(value: unknown, name: string, nonempty = false): string {
  if (typeof value !== 'string' || (nonempty && !value.trim())) {
    throw new DomainError(`${name} must be ${nonempty ? 'a nonempty' : 'a'} string`);
  }
  return nonempty ? value.trim() : value;
}

function taskById(state: StoredSnapshot, id: unknown): Task {
  text(id, 'Task ID', true);
  const task = state.tasks.find((task) => task.id === id);
  if (!task) throw new DomainError('Task not found', 404);
  return task;
}

function containerById(state: StoredSnapshot, id: unknown): Task {
  const task = taskById(state, id);
  if (task.kind !== 'container') throw new DomainError('Task must be a container');
  return task;
}

function normalizePrUrl(value: unknown): string {
  const raw = text(value, 'PR URL', true);
  const match =
    /^https:\/\/github\.com\/([a-z\d](?:[a-z\d-]*[a-z\d])?)\/([a-z\d_.-]+)\/pull\/(\d+)\/?(?:[?#].*)?$/i.exec(
      raw,
    );
  if (
    !match ||
    !Number.isSafeInteger(Number(match[3])) ||
    Number(match[3]) < 1 ||
    match[2] === '.' ||
    match[2] === '..' ||
    /[\r\n\t\\]/.test(raw)
  ) {
    throw new DomainError('PR URL must be an HTTPS GitHub pull request URL');
  }
  return `https://github.com/${match[1].toLowerCase()}/${match[2].toLowerCase()}/pull/${Number(match[3])}`;
}

function insertTask(state: StoredSnapshot, input: CreateTaskInput): Task {
  objectInput(input, ['title', 'description', 'kind', 'parentId', 'prUrl']);
  const title = text(input.title, 'Title', true);
  const description = input.description === undefined ? '' : text(input.description, 'Description');
  if (!['container', 'manual', 'pr'].includes(input.kind))
    throw new DomainError('Invalid task kind');
  if (input.kind !== 'pr' && input.prUrl !== undefined)
    throw new DomainError('Only PR tasks can have a PR URL');
  const prUrl = input.kind === 'pr' ? normalizePrUrl(input.prUrl) : null;
  const parentId =
    input.parentId === undefined || input.parentId === null
      ? null
      : containerById(state, input.parentId).id;
  const now = new Date().toISOString();
  const task: Task = {
    id: randomUUID(),
    title,
    description,
    kind: input.kind,
    parentId,
    manualDone: false,
    prUrl,
    prState: 'unknown',
    prMergeStatus: 'unknown',
    prCheckedAt: null,
    prError: null,
    createdAt: now,
    updatedAt: now,
  };
  state.tasks.push(task);
  return task;
}

function graph(state: StoredSnapshot) {
  const children = new Map(state.tasks.map((task) => [task.id, [] as string[]]));
  const prerequisites = new Map(state.tasks.map((task) => [task.id, [] as string[]]));
  const consumers = new Map(state.tasks.map((task) => [task.id, new Set<string>()]));
  for (const task of state.tasks) {
    if (task.parentId !== null) children.get(task.parentId)!.push(task.id);
  }
  for (const reference of state.references)
    children.get(reference.containerId)!.push(reference.taskId);
  for (const dependency of state.dependencies)
    prerequisites.get(dependency.dependentId)!.push(dependency.prerequisiteId);
  const requirements = new Map(
    state.tasks.map((task) => [
      task.id,
      new Set([...children.get(task.id)!, ...prerequisites.get(task.id)!]),
    ]),
  );
  for (const [id, required] of requirements) {
    for (const requirement of required) consumers.get(requirement)!.add(id);
  }
  return { children, prerequisites, requirements, consumers };
}

function derive(state: StoredSnapshot): Snapshot {
  const { children, prerequisites, requirements, consumers } = graph(state);
  const remaining = new Map([...requirements].map(([id, required]) => [id, required.size]));
  const queue = state.tasks.filter((task) => remaining.get(task.id) === 0).map((task) => task.id);
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  const views = new Map<string, TaskView>();
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    const task = tasks.get(id)!;
    const childrenIds = children.get(id)!;
    const complete = (required: string) => views.get(required)!.status === 'completed';
    const ownSatisfied =
      task.kind === 'manual'
        ? task.manualDone
        : task.kind === 'pr'
          ? task.prState === 'merged'
          : childrenIds.length > 0 && childrenIds.every(complete);
    const waitingOn = prerequisites.get(id)!.filter((required) => !complete(required));
    const status = ownSatisfied
      ? waitingOn.length
        ? 'ready'
        : 'completed'
      : waitingOn.length
        ? 'blocked'
        : 'available';
    views.set(id, { ...task, ownSatisfied, status, waitingOn, childrenIds });
    for (const consumer of consumers.get(id)!) {
      const count = remaining.get(consumer)! - 1;
      remaining.set(consumer, count);
      if (count === 0) queue.push(consumer);
    }
  }
  if (views.size !== state.tasks.length) {
    throw new DomainError(
      'This change would create a cycle across children, references, or dependencies',
      409,
    );
  }
  return { ...state, tasks: state.tasks.map((task) => views.get(task.id)!) };
}

function ownedIds(state: StoredSnapshot, id: string): Set<string> {
  taskById(state, id);
  const children = new Map<string, string[]>();
  for (const task of state.tasks) {
    if (task.parentId !== null) {
      const siblings = children.get(task.parentId) ?? [];
      siblings.push(task.id);
      children.set(task.parentId, siblings);
    }
  }
  const ids = new Set([id]);
  for (const current of ids) {
    for (const child of children.get(current) ?? []) ids.add(child);
  }
  return ids;
}

export const emptyPortableState = (): PortableState => ({
  version: 1,
  tasks: [],
  dependencies: [],
  references: [],
});

function portable(state: StoredSnapshot): PortableState {
  return {
    version: 1,
    tasks: state.tasks
      .map(({ id, title, description, kind, parentId, manualDone, prUrl }) => ({
        id,
        title,
        description,
        kind,
        parentId,
        manualDone,
        prUrl,
      }))
      .sort(byId),
    dependencies: state.dependencies
      .map(({ id, prerequisiteId, dependentId }) => ({ id, prerequisiteId, dependentId }))
      .sort(byId),
    references: state.references
      .map(({ id, containerId, taskId }) => ({ id, containerId, taskId }))
      .sort(byId),
  };
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function validatePortableState(value: unknown): PortableState {
  objectInput(value, ['version', 'tasks', 'dependencies', 'references']);
  if (value.version !== 1) throw new DomainError('Unsupported state version');
  const fields = {
    tasks: ['id', 'title', 'description', 'kind', 'parentId', 'manualDone', 'prUrl'],
    dependencies: ['id', 'prerequisiteId', 'dependentId'],
    references: ['id', 'containerId', 'taskId'],
  };
  const id = (value: unknown) => {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value) || value === 'root')
      throw new DomainError('Invalid state ID');
  };
  for (const collection of ['tasks', 'dependencies', 'references'] as const) {
    const items = value[collection];
    if (!Array.isArray(items)) throw new DomainError('State collections must be arrays');
    const seen = new Set<string>();
    for (const item of items) {
      objectInput(item, fields[collection]);
      if (Object.keys(item).length !== fields[collection].length)
        throw new DomainError('Missing state field');
      id(item.id);
      if (seen.has(item.id as string)) throw new DomainError('Duplicate state ID');
      seen.add(item.id as string);
      if (collection === 'tasks') {
        if (text(item.title, 'Title', true) !== item.title)
          throw new DomainError('Title must be trimmed');
        text(item.description, 'Description');
        if (!['manual', 'container', 'pr'].includes(item.kind as string))
          throw new DomainError('Invalid task kind');
        if (typeof item.manualDone !== 'boolean' || (item.kind !== 'manual' && item.manualDone))
          throw new DomainError('Invalid manual completion');
        if (item.parentId !== null) id(item.parentId);
        if (item.kind === 'pr') {
          if (normalizePrUrl(item.prUrl) !== item.prUrl)
            throw new DomainError('PR URL must be normalized');
        } else if (item.prUrl !== null) throw new DomainError('Only PR tasks can have a PR URL');
      } else {
        for (const field of fields[collection].slice(1)) id(item[field]);
      }
    }
  }
  const input = value as unknown as PortableState;
  const state: StoredSnapshot = {
    tasks: input.tasks.map((task) => ({
      ...task,
      prState: 'unknown',
      prMergeStatus: 'unknown',
      prCheckedAt: null,
      prError: null,
      createdAt: '',
      updatedAt: '',
    })),
    dependencies: input.dependencies,
    references: input.references,
    layouts: [],
  };
  for (const task of state.tasks) if (task.parentId !== null) containerById(state, task.parentId);
  const memberships = new Set(
    state.tasks
      .filter((task) => task.parentId !== null)
      .map((task) => `${task.parentId}/${task.id}`),
  );
  for (const ref of state.references) {
    containerById(state, ref.containerId);
    taskById(state, ref.taskId);
    const key = `${ref.containerId}/${ref.taskId}`;
    if (memberships.has(key)) throw new DomainError('Duplicate child membership');
    memberships.add(key);
  }
  const edges = new Set<string>();
  for (const edge of state.dependencies) {
    taskById(state, edge.prerequisiteId);
    taskById(state, edge.dependentId);
    const key = `${edge.prerequisiteId}/${edge.dependentId}`;
    if (edges.has(key)) throw new DomainError('Duplicate dependency');
    edges.add(key);
  }
  derive(state);
  return portable(state);
}

export interface SyncRecord {
  base: PortableState | null;
  lastSync: string | null;
  pending: { local: PortableState; merged: PortableState; sha: string | null } | null;
}

export class Store {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(databasePath: string) {
    text(databasePath, 'Database path', true);
    if (databasePath.includes('\0')) throw new DomainError('Invalid database path');
    if (databasePath !== ':memory:') mkdirSync(dirname(resolve(databasePath)), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    try {
      this.db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS foggybrain_snapshot (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          payload TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS foggybrain_sync (
          target TEXT PRIMARY KEY,
          payload TEXT NOT NULL
        );
        -- Full local snapshots, including PR cache and layouts, retained before sync writes.
        CREATE TABLE IF NOT EXISTS foggybrain_sync_backups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          target TEXT NOT NULL,
          created_at TEXT NOT NULL,
          payload TEXT NOT NULL
        );
      `);
      this.db
        .prepare('INSERT OR IGNORE INTO foggybrain_snapshot (id, payload) VALUES (1, ?)')
        .run(JSON.stringify({ tasks: [], dependencies: [], references: [], layouts: [] }));
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private read(): StoredSnapshot {
    const row = this.db.prepare('SELECT payload FROM foggybrain_snapshot WHERE id = 1').get()!;
    const state = JSON.parse(row.payload as string) as StoredSnapshot;
    for (const task of state.tasks) task.prMergeStatus ??= 'unknown';
    return state;
  }

  private mutate(change: (state: StoredSnapshot) => void): Snapshot {
    // Read under the write lock so separate store instances cannot overwrite each other's changes.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.read();
      change(state);
      const snapshot = derive(state);
      this.db
        .prepare('UPDATE foggybrain_snapshot SET payload = ? WHERE id = 1')
        .run(JSON.stringify(state));
      this.db.exec('COMMIT');
      return snapshot;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  snapshot(): Snapshot {
    return derive(this.read());
  }

  exportState(): PortableState {
    return portable(this.read());
  }

  syncRecord(target: SyncTarget): SyncRecord {
    const row = this.db
      .prepare('SELECT payload FROM foggybrain_sync WHERE target = ?')
      .get(JSON.stringify(target));
    return row
      ? (JSON.parse(row.payload as string) as SyncRecord)
      : { base: null, lastSync: null, pending: null };
  }

  private writeSyncRecord(target: SyncTarget, record: SyncRecord): void {
    this.db
      .prepare(
        'INSERT INTO foggybrain_sync (target, payload) VALUES (?, ?) ON CONFLICT(target) DO UPDATE SET payload = excluded.payload',
      )
      .run(JSON.stringify(target), JSON.stringify(record));
  }

  prepareSync(
    target: SyncTarget,
    expected: SyncRecord,
    local: PortableState,
    merged: PortableState,
    sha: string | null,
  ): SyncRecord {
    merged = validatePortableState(merged);
    let record!: SyncRecord;
    this.mutate((state) => {
      if (
        JSON.stringify(portable(state)) !== JSON.stringify(local) ||
        JSON.stringify(this.syncRecord(target)) !== JSON.stringify(expected)
      )
        throw new DomainError('Sync preview is stale; re-preview', 409);
      this.db
        .prepare(
          'INSERT INTO foggybrain_sync_backups (target, created_at, payload) VALUES (?, ?, ?)',
        )
        .run(JSON.stringify(target), new Date().toISOString(), JSON.stringify(state));
      record = { ...expected, pending: { local, merged, sha } };
      this.writeSyncRecord(target, record);
    });
    return record;
  }

  restoreSyncRecord(target: SyncTarget, expected: SyncRecord, previous: SyncRecord): void {
    // A single conditional write restores only this rejected operation, never a newer intent.
    this.db
      .prepare('UPDATE foggybrain_sync SET payload = ? WHERE target = ? AND payload = ?')
      .run(JSON.stringify(previous), JSON.stringify(target), JSON.stringify(expected));
  }

  finishSync(target: SyncTarget, expected: SyncRecord): void {
    const pending = expected.pending;
    if (!pending) throw new DomainError('No pending sync', 409);
    const merged = validatePortableState(pending.merged);
    this.mutate((state) => {
      if (
        JSON.stringify(portable(state)) !== JSON.stringify(pending.local) ||
        JSON.stringify(this.syncRecord(target)) !== JSON.stringify(expected)
      )
        throw new DomainError(
          'Local state changed during sync; re-preview to reconcile the upload',
          409,
        );
      this.db
        .prepare(
          'INSERT INTO foggybrain_sync_backups (target, created_at, payload) VALUES (?, ?, ?)',
        )
        .run(JSON.stringify(target), new Date().toISOString(), JSON.stringify(state));
      const previous = new Map(state.tasks.map((task) => [task.id, task]));
      const now = new Date().toISOString();
      state.tasks = merged.tasks.map((task) => {
        const old = previous.get(task.id);
        const samePr = old?.kind === 'pr' && task.kind === 'pr' && old.prUrl === task.prUrl;
        const unchanged =
          old && Object.entries(task).every(([key, value]) => old[key as keyof Task] === value);
        return {
          ...task,
          createdAt: old?.createdAt ?? now,
          updatedAt: unchanged ? old.updatedAt : now,
          prState: samePr ? old.prState : 'unknown',
          prMergeStatus: samePr ? old.prMergeStatus : 'unknown',
          prCheckedAt: samePr ? old.prCheckedAt : null,
          prError: samePr ? old.prError : null,
        };
      });
      state.dependencies = merged.dependencies;
      state.references = merged.references;
      const tasks = new Map(state.tasks.map((task) => [task.id, task]));
      state.layouts = state.layouts
        .filter(
          (layout) => layout.viewId === 'root' || tasks.get(layout.viewId)?.kind === 'container',
        )
        .map((layout) => ({
          ...layout,
          positions: layout.positions.filter((position) => {
            if (!tasks.has(position.nodeId)) return false;
            // Removed shared memberships should not leave a stale position in that view.
            const wasMember =
              previous.get(position.nodeId)?.parentId === layout.viewId ||
              pending.local.references.some(
                (ref) => ref.containerId === layout.viewId && ref.taskId === position.nodeId,
              );
            return (
              !wasMember ||
              state.references.some(
                (ref) => ref.containerId === layout.viewId && ref.taskId === position.nodeId,
              ) ||
              tasks.get(position.nodeId)?.parentId === layout.viewId
            );
          }),
        }));
      this.writeSyncRecord(target, { base: merged, lastSync: now, pending: null });
    });
  }

  createTask(input: CreateTaskInput): TaskView {
    let id: string;
    return this.mutate((state) => {
      id = insertTask(state, input).id;
    }).tasks.find((task) => task.id === id)!;
  }

  connectTask(id: string, input: ConnectTaskInput): TaskView {
    objectInput(input, ['direction', 'taskId', 'task', 'dependencyId']);
    if (input.direction !== 'prerequisite' && input.direction !== 'dependent')
      throw new DomainError('Direction must be prerequisite or dependent');
    if ('taskId' in input === 'task' in input)
      throw new DomainError('Exactly one of taskId or task is required');
    if ('dependencyId' in input) text(input.dependencyId, 'Dependency ID', true);
    let connectedId: string;
    return this.mutate((state) => {
      const anchor = taskById(state, id);
      let selected: Dependency | undefined;
      if (input.dependencyId !== undefined) {
        selected = state.dependencies.find((edge) => edge.id === input.dependencyId);
        if (!selected) throw new DomainError('Dependency not found', 404);
        const endpoint =
          input.direction === 'prerequisite' ? selected.dependentId : selected.prerequisiteId;
        if (endpoint !== anchor.id)
          throw new DomainError('Dependency does not match the anchor and direction', 409);
        state.dependencies = state.dependencies.filter((edge) => edge.id !== input.dependencyId);
      }
      connectedId =
        'taskId' in input ? taskById(state, input.taskId).id : insertTask(state, input.task!).id;
      const legs =
        input.direction === 'prerequisite'
          ? [
              [connectedId, anchor.id],
              ...(selected ? [[selected.prerequisiteId, connectedId]] : []),
            ]
          : [[anchor.id, connectedId], ...(selected ? [[connectedId, selected.dependentId]] : [])];
      for (const [prerequisiteId, dependentId] of legs) {
        if (prerequisiteId === dependentId)
          throw new DomainError('A task cannot depend on itself', 409);
        const exists = state.dependencies.some(
          (edge) => edge.prerequisiteId === prerequisiteId && edge.dependentId === dependentId,
        );
        if (exists) {
          if (!selected) throw new DomainError('Dependency already exists', 409);
        } else {
          state.dependencies.push({ id: randomUUID(), prerequisiteId, dependentId });
        }
      }
    }).tasks.find((task) => task.id === connectedId)!;
  }

  updateTask(id: string, input: UpdateTaskInput): TaskView {
    objectInput(input, ['title', 'description', 'prUrl']);
    if (!Object.keys(input).length) throw new DomainError('At least one field is required');
    return this.mutate((state) => {
      const task = taskById(state, id);
      if ('title' in input) task.title = text(input.title, 'Title', true);
      if ('description' in input) task.description = text(input.description, 'Description');
      if ('prUrl' in input) {
        if (task.kind !== 'pr') throw new DomainError('Only PR tasks can have a PR URL');
        const prUrl = normalizePrUrl(input.prUrl);
        if (prUrl !== task.prUrl) {
          task.prUrl = prUrl;
          task.prState = 'unknown';
          task.prMergeStatus = 'unknown';
          task.prCheckedAt = null;
          task.prError = null;
        }
      }
      task.updatedAt = new Date().toISOString();
    }).tasks.find((task) => task.id === id)!;
  }

  setDone(id: string, done: boolean): TaskView {
    if (typeof done !== 'boolean') throw new DomainError('Done must be a boolean');
    return this.mutate((state) => {
      const task = taskById(state, id);
      if (task.kind !== 'manual') throw new DomainError('Only manual tasks can be marked done');
      task.manualDone = done;
      task.updatedAt = new Date().toISOString();
    }).tasks.find((task) => task.id === id)!;
  }

  addDependency(prerequisiteId: string, dependentId: string): Dependency {
    const dependency = { id: randomUUID(), prerequisiteId, dependentId };
    this.mutate((state) => {
      taskById(state, prerequisiteId);
      taskById(state, dependentId);
      if (
        state.dependencies.some(
          (edge) => edge.prerequisiteId === prerequisiteId && edge.dependentId === dependentId,
        )
      ) {
        throw new DomainError('Dependency already exists', 409);
      }
      state.dependencies.push(dependency);
    });
    return dependency;
  }

  removeDependency(id: string): void {
    text(id, 'Dependency ID', true);
    this.mutate((state) => {
      const index = state.dependencies.findIndex((edge) => edge.id === id);
      if (index === -1) throw new DomainError('Dependency not found', 404);
      state.dependencies.splice(index, 1);
    });
  }

  addReference(containerId: string, taskId: string): TaskReference {
    const reference = { id: randomUUID(), containerId, taskId };
    this.mutate((state) => {
      containerById(state, containerId);
      const task = taskById(state, taskId);
      if (
        task.parentId === containerId ||
        state.references.some((ref) => ref.containerId === containerId && ref.taskId === taskId)
      ) {
        throw new DomainError('Task is already a child of this container', 409);
      }
      state.references.push(reference);
    });
    return reference;
  }

  removeReference(id: string): void {
    text(id, 'Reference ID', true);
    this.mutate((state) => {
      const index = state.references.findIndex((ref) => ref.id === id);
      if (index === -1) throw new DomainError('Reference not found', 404);
      const [reference] = state.references.splice(index, 1);
      for (const layout of state.layouts) {
        if (layout.viewId === reference.containerId) {
          layout.positions = layout.positions.filter(
            (position) => position.nodeId !== reference.taskId,
          );
        }
      }
    });
  }

  previewDeletion(id: string): DeletionPreview {
    const state = this.read();
    const deleted = ownedIds(state, id);
    const affected = new Set(deleted);
    const { consumers } = graph(state);
    for (const current of affected) {
      for (const consumer of consumers.get(current)!) affected.add(consumer);
    }
    return {
      taskIds: [...deleted],
      affectedTasks: derive(state).tasks.filter(
        (task) => affected.has(task.id) && !deleted.has(task.id),
      ),
      removedDependencies: state.dependencies.filter(
        (edge) => deleted.has(edge.prerequisiteId) || deleted.has(edge.dependentId),
      ),
      removedReferences: state.references.filter(
        (ref) => deleted.has(ref.containerId) || deleted.has(ref.taskId),
      ),
    };
  }

  deleteTask(id: string): string[] {
    let deleted = new Set<string>();
    this.mutate((state) => {
      deleted = ownedIds(state, id);
      state.tasks = state.tasks.filter((task) => !deleted.has(task.id));
      state.dependencies = state.dependencies.filter(
        (edge) => !deleted.has(edge.prerequisiteId) && !deleted.has(edge.dependentId),
      );
      state.references = state.references.filter(
        (ref) => !deleted.has(ref.containerId) && !deleted.has(ref.taskId),
      );
      state.layouts = state.layouts
        .filter((layout) => !deleted.has(layout.viewId))
        .map((layout) => ({
          ...layout,
          positions: layout.positions.filter((position) => !deleted.has(position.nodeId)),
        }));
    });
    return [...deleted];
  }

  saveLayout(input: Layout): Layout {
    objectInput(input, ['viewId', 'mode', 'positions']);
    text(input.viewId, 'View ID', true);
    if (input.mode !== 'auto' && input.mode !== 'manual')
      throw new DomainError('Invalid layout mode');
    if (!Array.isArray(input.positions)) throw new DomainError('Positions must be an array');
    return this.mutate((state) => {
      if (input.viewId !== 'root') containerById(state, input.viewId);
      const seen = new Set<string>();
      const positions: Layout['positions'] = [];
      for (const position of input.positions) {
        objectInput(position, ['nodeId', 'x', 'y']);
        taskById(state, position.nodeId);
        if (seen.has(position.nodeId)) throw new DomainError('Duplicate layout node');
        seen.add(position.nodeId);
        if (
          typeof position.x !== 'number' ||
          !Number.isFinite(position.x) ||
          typeof position.y !== 'number' ||
          !Number.isFinite(position.y)
        ) {
          throw new DomainError('Layout coordinates must be finite numbers');
        }
        positions.push({ nodeId: position.nodeId, x: position.x, y: position.y });
      }
      const layout = { viewId: input.viewId, mode: input.mode, positions };
      const index = state.layouts.findIndex((existing) => existing.viewId === input.viewId);
      if (index === -1) state.layouts.push(layout);
      else state.layouts[index] = layout;
    }).layouts.find((layout) => layout.viewId === input.viewId)!;
  }

  updatePr(
    id: string,
    input: {
      state?: PrState;
      mergeStatus?: PrMergeStatus;
      checkedAt: string;
      error: string | null;
    },
  ): TaskView {
    objectInput(input, ['state', 'mergeStatus', 'checkedAt', 'error']);
    const checkedAt = text(input.checkedAt, 'PR check time', true);
    if (!Number.isFinite(Date.parse(checkedAt))) throw new DomainError('Invalid PR check time');
    if (input.error !== null && typeof input.error !== 'string')
      throw new DomainError('PR error must be a string or null');
    if (
      input.state !== undefined &&
      !['unknown', 'open', 'closed', 'merged'].includes(input.state)
    ) {
      throw new DomainError('Invalid PR state');
    }
    if (
      input.mergeStatus !== undefined &&
      ![
        'unknown',
        'draft',
        'under_review',
        'changes_requested',
        'checks_pending',
        'checks_failing',
        'conflicts',
        'blocked',
        'ready',
      ].includes(input.mergeStatus)
    ) {
      throw new DomainError('Invalid PR merge status');
    }
    return this.mutate((state) => {
      const task = taskById(state, id);
      if (task.kind !== 'pr') throw new DomainError('Only PR tasks can receive PR updates');
      // Partial polling failures must not discard independently verified fields.
      if (input.state !== undefined) task.prState = input.state;
      if (input.mergeStatus !== undefined) task.prMergeStatus = input.mergeStatus;
      task.prCheckedAt = checkedAt;
      task.prError = input.error;
      task.updatedAt = new Date().toISOString();
    }).tasks.find((task) => task.id === id)!;
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
