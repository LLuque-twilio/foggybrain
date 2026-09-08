import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DomainError, Store } from './core.js';
import { discoverOwnedRepositories, discoverRepositoryEntries, GithubPoller } from './github.js';
import { StateSync, validateTarget } from './sync.js';
import type { SyncTarget, Workspace, WorkspaceList, WorkspaceRemovalPreview } from './shared.js';

// One server must own a data directory. This guard covers in-process managers,
// not independent processes; removal does not provide cross-process locking.
const managers = new Map<string, Set<WorkspaceManager>>();

export interface WorkspaceRuntime {
  store: Store;
  github: GithubPoller;
  sync: StateSync;
}

export interface WorkspaceManagerOptions {
  dataDir: string;
  legacyTarget?: SyncTarget | null;
  dedicatedToken?: string;
  githubToken?: string;
  intervalMs?: number;
  fetch?: typeof fetch;
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DomainError('Expected a workspace JSON object');
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new DomainError('Workspace contains unsupported fields');
  return value as Record<string, unknown>;
}

function configuration(value: unknown): Omit<Workspace, 'id'> {
  const body = object(value, ['name', 'type', 'target', 'credential']);
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100)
    throw new DomainError('Workspace name must contain 1 to 100 characters');
  if (body.type !== 'local' && body.type !== 'cloud')
    throw new DomainError('Workspace type must be local or cloud');
  if (body.type === 'local') {
    if ('target' in body || 'credential' in body)
      throw new DomainError('Local workspaces cannot specify a target or credential');
    return { name: body.name.trim(), type: 'local', target: null, credential: null };
  }
  const target = object(body.target, ['repo', 'branch', 'path']) as unknown as SyncTarget;
  validateTarget(target);
  const credential = 'credential' in body ? body.credential : 'dedicated';
  if (credential !== 'dedicated' && credential !== 'github')
    throw new DomainError('Cloud workspace credential must be dedicated or github');
  return {
    name: body.name.trim(),
    type: 'cloud',
    credential,
    target: { repo: target.repo.toLowerCase(), branch: target.branch, path: target.path },
  };
}

export class WorkspaceManager {
  private readonly registry: DatabaseSync;
  private readonly runtimes = new Map<string, WorkspaceRuntime>();
  private started = false;
  private closing: Promise<void> | null = null;
  private readonly directory: string;
  private readonly removals = new Map<string, Promise<WorkspaceList>>();

  constructor(private readonly options: WorkspaceManagerOptions) {
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    this.directory = realpathSync(options.dataDir);
    const active = managers.get(this.directory) ?? new Set<WorkspaceManager>();
    if ([...active].some((manager) => manager.removals.size))
      throw new DomainError('Workspace removal is in progress', 409);
    this.registry = new DatabaseSync(join(options.dataDir, 'workspaces.sqlite'));
    try {
      this.registry.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, config TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_settings (id INTEGER PRIMARY KEY CHECK (id = 1), default_id TEXT);
      CREATE TABLE IF NOT EXISTS workspace_removals (id TEXT PRIMARY KEY);`);
      for (const row of this.registry.prepare('SELECT id FROM workspace_removals').all()) {
        if (active.size)
          throw new DomainError('Workspace cleanup requires exclusive ownership', 409);
        this.cleanup(row.id as string);
      }
      const target = options.legacyTarget;
      if (target) validateTarget(target);
      this.registry.exec('BEGIN IMMEDIATE');
      try {
        if (
          this.registry
            .prepare('PRAGMA table_info(workspace_settings)')
            .all()
            .some((column) => column.name === 'default_id' && column.notnull === 1)
        ) {
          this.registry.exec(`
            ALTER TABLE workspace_settings RENAME TO workspace_settings_old;
            CREATE TABLE workspace_settings (id INTEGER PRIMARY KEY CHECK (id = 1), default_id TEXT);
            INSERT INTO workspace_settings SELECT id, default_id FROM workspace_settings_old;
            DROP TABLE workspace_settings_old;
          `);
        }
        if (!this.registry.prepare('SELECT 1 FROM workspace_settings').get()) {
          this.registry
            .prepare('INSERT OR IGNORE INTO workspaces (id, config) VALUES (?, ?)')
            .run(
              'default',
              JSON.stringify({ name: 'Personal', type: 'local', target: null, credential: null }),
            );
          this.registry
            .prepare('INSERT INTO workspace_settings (id, default_id) VALUES (1, ?)')
            .run('default');
        }
        if (target)
          this.registry
            .prepare(
              `UPDATE workspaces SET config = json_set(config,
        '$.type', 'cloud', '$.target', json(?),
        '$.credential', 'dedicated')
      WHERE id = 'default' AND json_extract(config, '$.type') = 'local'`,
            )
            .run(JSON.stringify(target));
        this.registry.exec('COMMIT');
      } catch (error) {
        this.registry.exec('ROLLBACK');
        throw error;
      }
      active.add(this);
      managers.set(this.directory, active);
    } catch (error) {
      this.registry.close();
      throw error;
    }
  }

  list(): WorkspaceList {
    const rows = this.registry.prepare('SELECT id, config FROM workspaces ORDER BY rowid').all();
    return {
      workspaces: rows.map((row) => ({
        id: row.id as string,
        ...JSON.parse(row.config as string),
      })),
      defaultWorkspaceId: this.registry
        .prepare('SELECT default_id FROM workspace_settings WHERE id = 1')
        .get()!.default_id as string | null,
      limit: 3,
    };
  }

  private workspace(id: string): Workspace {
    if (this.removals.has(id)) throw new DomainError('Workspace removal is in progress', 409);
    const workspace = this.list().workspaces.find((entry) => entry.id === id);
    if (!workspace) throw new DomainError('Workspace not found', 404);
    return workspace;
  }

  private cleanup(id: string): void {
    if (id !== 'default' && !/^[0-9a-f-]{36}$/.test(id))
      throw new Error('Invalid workspace cleanup ID');
    const path = join(
      this.directory,
      id === 'default' ? 'foggybrain.sqlite' : `workspace-${id}.sqlite`,
    );
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try {
        unlinkSync(path + suffix);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    this.registry.prepare('DELETE FROM workspace_removals WHERE id = ?').run(id);
  }

  removalPreview(id: string): WorkspaceRemovalPreview {
    const { store, sync } = this.get(id);
    const list = this.list();
    const workspace = this.workspace(id);
    const graph = store.snapshot();
    const status = sync.getStatus();
    const reason = status.syncing
      ? 'Workspace sync is active'
      : (managers.get(this.directory)?.size ?? 0) > 1
        ? 'Workspace removal requires a single active manager'
        : null;
    return {
      workspace,
      taskCount: graph.tasks.length,
      dependencyCount: graph.dependencies.length,
      referenceCount: graph.references.length,
      dirty: status.dirty,
      canRemove: reason === null,
      reason,
      revision: createHash('sha256')
        .update(JSON.stringify({ id, list, graph, status }))
        .digest('hex'),
    };
  }

  async remove(id: string, input: unknown): Promise<WorkspaceList> {
    const body = object(input, ['revision']);
    if (typeof body.revision !== 'string' || !body.revision.trim())
      throw new DomainError('Removal revision must be a nonempty string');
    const preview = this.removalPreview(id);
    if (!preview.canRemove) throw new DomainError(preview.reason!, 409);
    if (preview.revision !== body.revision)
      throw new DomainError('Workspace removal preview is stale', 409);
    const runtime = this.get(id);
    // Commit the tombstone before yielding or touching files: failed cleanup
    // must never resurrect a workspace, including the legacy default.
    this.registry.exec('BEGIN IMMEDIATE');
    try {
      this.registry.prepare('INSERT INTO workspace_removals (id) VALUES (?)').run(id);
      this.registry.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
      this.registry
        .prepare(
          `UPDATE workspace_settings SET default_id =
        (SELECT id FROM workspaces ORDER BY rowid LIMIT 1) WHERE default_id = ?`,
        )
        .run(id);
      this.registry.exec('COMMIT');
    } catch (error) {
      this.registry.exec('ROLLBACK');
      throw error;
    }
    // Schedule teardown only after the scoped-access barrier is installed.
    const removal = Promise.resolve()
      .then(async () => {
        await Promise.all([runtime.github.stop(), runtime.sync.stop()]);
        runtime.store.close();
        this.runtimes.delete(id);
        this.cleanup(id);
        return this.list();
      })
      .finally(() => {
        this.removals.delete(id);
      });
    this.removals.set(id, removal);
    return removal;
  }

  repositories(credential: unknown = 'dedicated') {
    if (this.closing) throw new DomainError('Workspace service is stopped', 503);
    if (credential !== 'dedicated' && credential !== 'github')
      throw new DomainError('Repository credential must be dedicated or github');
    return discoverOwnedRepositories(
      this.token({ type: 'cloud', credential })!,
      this.options.fetch,
    );
  }

  repositoryEntries(credential: unknown, repo: unknown, branch?: unknown) {
    if (this.closing) throw new DomainError('Workspace service is stopped', 503);
    if (credential !== 'dedicated' && credential !== 'github')
      throw new DomainError('Discovery credential must be dedicated or github');
    validateTarget({ repo, branch: branch ?? 'main', path: 'state.json' } as SyncTarget);
    return discoverRepositoryEntries(
      this.token({ type: 'cloud', credential })!,
      repo as string,
      branch as string | undefined,
      this.options.fetch,
    );
  }

  private token(workspace: Pick<Workspace, 'type' | 'credential'>): string | undefined {
    if (workspace.type === 'local') return undefined;
    const token =
      workspace.credential === 'github' ? this.options.githubToken : this.options.dedicatedToken;
    if (!token || !/^[\x21-\x7e]+$/.test(token))
      throw new DomainError(
        workspace.credential === 'github'
          ? 'GitHub credential is unavailable. Set GH_TOKEN or GITHUB_TOKEN, or sign in with gh auth login.'
          : 'Dedicated sync credential is unavailable. Set FOGGY_SYNC_TOKEN.',
        503,
      );
    return token;
  }

  create(input: unknown): Workspace {
    if (this.closing) throw new DomainError('Workspace service is stopped', 503);
    const config = configuration(input);
    this.token(config);
    const workspace = { id: randomUUID(), ...config };
    this.registry.exec('BEGIN IMMEDIATE');
    try {
      if (this.list().workspaces.length >= 3)
        throw new DomainError('Workspace limit of 3 reached', 409);
      this.registry
        .prepare('INSERT INTO workspaces (id, config) VALUES (?, ?)')
        .run(workspace.id, JSON.stringify(config));
      this.registry
        .prepare('UPDATE workspace_settings SET default_id = ? WHERE default_id IS NULL')
        .run(workspace.id);
      this.registry.exec('COMMIT');
    } catch (error) {
      this.registry.exec('ROLLBACK');
      throw error;
    }
    if (this.started) this.get(workspace.id);
    return workspace;
  }

  update(id: string, input: unknown): Workspace {
    if (this.closing) throw new DomainError('Workspace service is stopped', 503);
    const body = object(input, ['name', 'type', 'target', 'credential']);
    this.registry.exec('BEGIN IMMEDIATE');
    let result: Workspace;
    try {
      const previous = this.workspace(id);
      if ('type' in body && body.type !== 'cloud')
        throw new DomainError(
          'Workspace type updates only support conversion to cloud; demotion is not supported',
        );
      const { id: _id, ...old } = previous;
      const config = configuration({
        ...(previous.type === 'local' ? { name: old.name, type: old.type } : old),
        ...body,
      });
      if (
        previous.type === 'cloud' &&
        (JSON.stringify(config.target) !== JSON.stringify(previous.target) ||
          config.credential !== previous.credential)
      )
        throw new DomainError(
          'Cloud workspace retargeting or credential changes are not supported',
        );
      if (previous.type === 'local' && config.type === 'cloud') this.token(config);
      this.registry
        .prepare('UPDATE workspaces SET config = ? WHERE id = ?')
        .run(JSON.stringify(config), id);
      this.registry.exec('COMMIT');
      result = { id, ...config };
    } catch (error) {
      this.registry.exec('ROLLBACK');
      throw error;
    }
    const runtime = this.runtimes.get(id);
    if (runtime && result.type === 'cloud' && !runtime.sync.getStatus().configured) {
      void runtime.sync.stop();
      runtime.sync = new StateSync(runtime.store, {
        target: result.target,
        resolveToken: () => this.token(result),
        fetch: this.options.fetch,
      });
    }
    return result;
  }

  get(id: string): WorkspaceRuntime {
    if (this.closing) throw new DomainError('Workspace service is stopped', 503);
    const workspace = this.workspace(id);
    const existing = this.runtimes.get(id);
    if (existing) return existing;
    const store = new Store(
      join(this.options.dataDir, id === 'default' ? 'foggybrain.sqlite' : `workspace-${id}.sqlite`),
    );
    try {
      const github = new GithubPoller(store, {
        token: this.options.githubToken,
        intervalMs: this.options.intervalMs,
        fetch: this.options.fetch,
      });
      const sync = new StateSync(store, {
        target: workspace.target,
        resolveToken: () => this.token(workspace),
        fetch: this.options.fetch,
      });
      const runtime = { store, github, sync };
      this.runtimes.set(id, runtime);
      if (this.started) github.start();
      return runtime;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  start(): void {
    for (const workspace of this.list().workspaces) this.get(workspace.id);
    this.started = true;
    for (const runtime of this.runtimes.values()) runtime.github.start();
  }

  close(): Promise<void> {
    this.closing ??= Promise.allSettled([...this.removals.values()])
      .then(() =>
        Promise.all(
          [...this.runtimes.values()].map(async ({ store, github, sync }) => {
            await Promise.all([github.stop(), sync.stop()]);
            store.close();
          }),
        ),
      )
      .then(() => {
        this.registry.close();
        const active = managers.get(this.directory)!;
        active.delete(this);
        if (!active.size) managers.delete(this.directory);
      });
    return this.closing;
  }
}
