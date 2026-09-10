import { randomUUID } from 'node:crypto';
import { safeSyncRef } from './shared.js';
import {
  DomainError,
  emptyPortableState,
  Store,
  validatePortableState,
  type SyncRecord,
} from './core.js';
import type {
  PortableState,
  SyncChange,
  SyncConflict,
  SyncPreview,
  SyncStatus,
  SyncTarget,
} from './shared.js';

const MAX_CONTENT = 1024 * 1024;
const collections = ['tasks', 'dependencies', 'references', 'tags'] as const;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

class RejectedSyncWrite extends DomainError {}

export function readSyncConfig(env: NodeJS.ProcessEnv): SyncTarget | null {
  const token = env.FOGGY_SYNC_TOKEN;
  if (token !== undefined && !/^[\x21-\x7e]+$/.test(token))
    throw new DomainError('FOGGY_SYNC_TOKEN must contain only visible ASCII characters');
  const names = ['FOGGY_SYNC_REPO', 'FOGGY_SYNC_BRANCH', 'FOGGY_SYNC_PATH'];
  if (names.every((name) => env[name] === undefined)) return null;
  const repo = env.FOGGY_SYNC_REPO;
  const branch = env.FOGGY_SYNC_BRANCH ?? 'main';
  const path = env.FOGGY_SYNC_PATH ?? 'foggybrain/state.json';
  if (!repo) throw new DomainError('Sync target requires FOGGY_SYNC_REPO');
  validateTarget({ repo, branch, path });
  return { repo: repo.toLowerCase(), branch, path };
}

export function validateTarget(target: SyncTarget): void {
  if (
    !target ||
    typeof target.repo !== 'string' ||
    !/^[a-z\d](?:[a-z\d-]*[a-z\d])?\/[a-z\d_.-]+$/i.test(target.repo) ||
    ['.', '..'].includes(target.repo.split('/')[1])
  )
    throw new DomainError('Invalid sync repository');
  for (const [name, value] of [
    ['branch', target.branch],
    ['path', target.path],
  ]) {
    if (!safeSyncRef(value)) throw new DomainError(`Unsafe sync ${name}`);
  }
}

function changes(before: PortableState, after: PortableState): SyncChange[] {
  const result: SyncChange[] = [];
  for (const collection of collections) {
    const old = new Map<string, { id: string; title?: string }>(
      before[collection].map((item) => [item.id, item]),
    );
    const next = new Map<string, { id: string; title?: string }>(
      after[collection].map((item) => [item.id, item]),
    );
    for (const id of [...new Set([...old.keys(), ...next.keys()])].sort()) {
      const a = old.get(id),
        b = next.get(id);
      if (!equal(a, b))
        result.push({
          collection,
          id,
          ...((b ?? a)?.title ? { title: (b ?? a)!.title } : {}),
          kind: !a ? 'added' : !b ? 'deleted' : 'updated',
        });
    }
  }
  return result;
}

function merge(
  base: PortableState,
  local: PortableState,
  remote: PortableState,
  resolution: 'local' | 'remote' | null,
) {
  const conflicts: SyncConflict[] = [];
  const choose = (path: string, b: unknown, l: unknown, r: unknown): unknown => {
    if (equal(l, r)) return l;
    if (equal(b, l)) return r;
    if (equal(b, r)) return l;
    conflicts.push({ path, base: b ?? null, local: l ?? null, remote: r ?? null });
    return resolution === 'remote' ? r : l;
  };
  const merged = emptyPortableState();
  for (const collection of collections) {
    type Item = { id: string } & Record<string, unknown>;
    const maps = [base, local, remote].map(
      (state) => new Map(state[collection].map((item) => [item.id, item as unknown as Item])),
    );
    const ids = [...new Set(maps.flatMap((map) => [...map.keys()]))].sort();
    for (const id of ids) {
      const [b, l, r] = maps.map((map) => map.get(id));
      let item: unknown;
      if (b && l && r) {
        item = Object.fromEntries(
          Object.keys(b).map((field) => [
            field,
            choose(`${collection}/${id}/${field}`, b[field], l[field], r[field]),
          ]),
        );
      } else item = choose(`${collection}/${id}`, b, l, r);
      if (item) (merged[collection] as unknown[]).push(item);
    }
  }
  const tagValue = (state: PortableState, tagId: string) => ({
    tag: state.tags.find((tag) => tag.id === tagId) ?? null,
    taskIds: state.tasks
      .filter((task) => task.tagIds.includes(tagId))
      .map((task) => task.id)
      .sort(),
  });
  const dangling = new Set(
    merged.tasks.flatMap((task) =>
      task.tagIds.filter(
        (tagId) => tagId !== 'favorites' && !merged.tags.some((tag) => tag.id === tagId),
      ),
    ),
  );
  for (const tagId of dangling) {
    if (!base.tags.some((tag) => tag.id === tagId)) continue;
    const localValue = tagValue(local, tagId);
    const remoteValue = tagValue(remote, tagId);
    if ((localValue.tag === null) === (remoteValue.tag === null)) continue;
    conflicts.push({
      path: `tags/${tagId}/memberships`,
      base: tagValue(base, tagId),
      local: localValue,
      remote: remoteValue,
    });
    const selected = resolution === 'remote' ? remoteValue : localValue;
    merged.tags = merged.tags.filter((tag) => tag.id !== tagId);
    if (selected.tag) merged.tags.push(selected.tag);
    const memberships = new Set(selected.taskIds);
    for (const task of merged.tasks) {
      task.tagIds = task.tagIds.filter((id) => id !== tagId);
      if (selected.tag && memberships.has(task.id)) task.tagIds.push(tagId);
    }
    merged.tags.sort((a, b) => a.id.localeCompare(b.id));
  }
  let validationError: string | null = null;
  for (const conflict of conflicts) {
    const match = /^tasks\/([^/]+)$/.exec(conflict.path);
    if (!match || conflict.base === null || (conflict.local !== null && conflict.remote !== null))
      continue;
    const retained = merged.tasks.find((task) => task.id === match[1]);
    if (!retained) continue;
    const survivor = conflict.local === null ? remote : local;
    const deleted = conflict.local === null ? local : remote;
    const descendants = new Set([retained.id]);
    for (const id of descendants) {
      for (const task of base.tasks) if (task.parentId === id) descendants.add(task.id);
    }
    const cascade = new Set(
      [...descendants].filter((id) => !deleted.tasks.some((task) => task.id === id)),
    );
    // A task-level resolution cannot implicitly approve the losing deletion's cascade.
    const lostTasks = survivor.tasks.some(
      (task) => cascade.has(task.id) && !merged.tasks.some((next) => next.id === task.id),
    );
    const lostDependencies = base.dependencies.some(
      (edge) =>
        (cascade.has(edge.prerequisiteId) || cascade.has(edge.dependentId)) &&
        survivor.dependencies.some((next) => next.id === edge.id) &&
        !merged.dependencies.some((next) => next.id === edge.id),
    );
    const lostReferences = base.references.some(
      (ref) =>
        (cascade.has(ref.containerId) || cascade.has(ref.taskId)) &&
        survivor.references.some((next) => next.id === ref.id) &&
        !merged.references.some((next) => next.id === ref.id),
    );
    const lostParent =
      retained.parentId !== null && !merged.tasks.some((task) => task.id === retained.parentId);
    if (lostTasks || lostDependencies || lostReferences || lostParent) {
      validationError =
        'Structural delete/edit conflict: retaining a task would discard baseline dependencies, references, or owned family members through a deletion cascade. Reconcile the related structure before re-previewing.';
      break;
    }
  }
  return { merged, conflicts, validationError };
}

interface SavedPreview {
  preview: SyncPreview;
  local: PortableState;
  merged: PortableState;
  remote: PortableState;
  sha: string | null;
  record: SyncRecord;
}

export class StateSync {
  private readonly target: SyncTarget | null;
  private token?: string;
  private readonly resolveToken?: () => string | undefined;
  private readonly fetcher: typeof fetch;
  private saved: SavedPreview | null = null;
  private active: Promise<unknown> | null = null;
  private controller: AbortController | null = null;
  private stopped = false;

  constructor(
    private readonly store: Store,
    options: {
      target: SyncTarget | null;
      token?: string;
      resolveToken?: () => string | undefined;
      fetch?: typeof fetch;
    },
  ) {
    if (options.target) {
      validateTarget(options.target);
      if (!options.resolveToken && (!options.token || !/^[\x21-\x7e]+$/.test(options.token)))
        throw new DomainError('A separate sync token is required');
    }
    this.target = options.target
      ? {
          repo: options.target.repo.toLowerCase(),
          branch: options.target.branch,
          path: options.target.path,
        }
      : null;
    this.token = options.token;
    this.resolveToken = options.resolveToken;
    this.fetcher = options.fetch ?? fetch;
  }

  getStatus(): SyncStatus {
    const record = this.target ? this.store.syncRecord(this.target) : null;
    return {
      configured: this.target !== null,
      target: this.target ? { ...this.target } : null,
      lastSync: record?.lastSync ?? null,
      dirty:
        !!record?.pending || !equal(this.store.exportState(), record?.base ?? emptyPortableState()),
      syncing: this.active !== null,
    };
  }

  private run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new DomainError('Sync service is stopped', 503));
    if (!this.target) return Promise.reject(new DomainError('State sync is not configured', 503));
    if (this.active) return Promise.reject(new DomainError('State sync is already running', 409));
    if (this.resolveToken) {
      try {
        this.token = this.resolveToken();
        if (!this.token || !/^[\x21-\x7e]+$/.test(this.token))
          throw new DomainError('A sync token is required', 503);
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), 10_000);
    const active = Promise.resolve()
      .then(() => operation(controller.signal))
      .catch((error: unknown) => {
        if (error instanceof DomainError) throw error;
        throw new DomainError('GitHub state sync failed; re-preview before trying again', 502);
      })
      .finally(() => {
        clearTimeout(timer);
        this.active = null;
        this.controller = null;
      });
    this.active = active;
    return active;
  }

  private async request(
    operation:
      'reading repository' | 'reading branch' | 'reading state file' | 'writing state file',
    suffix: string,
    signal: AbortSignal,
    init: RequestInit = {},
    missing = false,
  ): Promise<unknown> {
    try {
      signal.throwIfAborted();
      const url = `https://api.github.com/repos/${this.target!.repo}${suffix}`;
      const response = await this.fetcher(url, {
        ...init,
        signal,
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
      });
      if (response.redirected || (response.url && response.url !== url))
        throw new DomainError('GitHub returned an unexpected response URL', 502);
      if (missing && response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const guidance: Record<number, string> = {
          401: 'Check that the selected server sync credential is valid and unexpired.',
          403: 'Check repository permissions, organization/SSO approval, and GitHub rate limits; writes require Contents read/write and may be restricted by branch rules.',
          404: 'Check the configured repository, existing branch, and path, and the selected credential access; GitHub may hide private resources.',
          409: 'Remote state may have changed; re-preview and review before applying again.',
          422: 'Check the state file target and branch rules; re-preview and review before applying again.',
          429: 'GitHub rate limit reached; wait before requesting a new preview.',
        };
        const message = `GitHub state sync failed while ${operation} (HTTP ${response.status}). ${
          guidance[response.status] ??
          (response.status >= 500 && response.status <= 599
            ? 'GitHub service error; check GitHub service status and wait before requesting a new preview.'
            : 'Check the sync target and selected server credential; re-preview before applying again.')
        }${init.method === 'PUT' ? ' Do not retry the apply blindly; the upload may need reconciliation.' : ''}`;
        if (init.method === 'PUT' && (response.status === 409 || response.status === 422))
          throw new RejectedSyncWrite(message, 409);
        throw new DomainError(
          message,
          response.status === 409 || response.status === 422 ? 409 : 502,
        );
      }
      if (!response.body) throw new DomainError('Empty GitHub response', 502);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2 * MAX_CONTENT)
            throw new DomainError('GitHub response exceeds size limit', 502);
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      signal.throwIfAborted();
      try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      } catch {
        throw new DomainError('GitHub returned malformed JSON', 502);
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const reason = signal.aborted
        ? this.stopped
          ? 'was cancelled because the sync service stopped'
          : 'timed out after the 10-second sync deadline'
        : 'failed during transport; check server network, DNS, TLS, and proxy connectivity';
      throw new DomainError(
        `GitHub state sync ${reason} while ${operation}. Re-preview before applying again.${
          init.method === 'PUT'
            ? ' The upload may have committed; do not retry the apply blindly.'
            : ''
        }`,
        502,
      );
    }
  }

  private contentPath(): string {
    return `/contents/${this.target!.path.split('/').map(encodeURIComponent).join('/')}`;
  }

  private async remote(signal: AbortSignal): Promise<{ state: PortableState; sha: string | null }> {
    const repo = (await this.request('reading repository', '', signal)) as {
      private?: unknown;
    } | null;
    if (repo?.private !== true)
      throw new DomainError('State sync requires a private GitHub repository');
    await this.request(
      'reading branch',
      `/branches/${encodeURIComponent(this.target!.branch)}`,
      signal,
    );
    const file = (await this.request(
      'reading state file',
      `${this.contentPath()}?ref=${encodeURIComponent(this.target!.branch)}`,
      signal,
      {},
      true,
    )) as Record<string, unknown> | null;
    if (file === null) return { state: emptyPortableState(), sha: null };
    if (
      file.type !== 'file' ||
      file.encoding !== 'base64' ||
      typeof file.sha !== 'string' ||
      !/^[a-f0-9]{40,64}$/.test(file.sha) ||
      typeof file.content !== 'string' ||
      typeof file.size !== 'number' ||
      !Number.isInteger(file.size) ||
      file.size < 0 ||
      file.size > MAX_CONTENT
    )
      throw new DomainError('Invalid GitHub state file', 502);
    const encoded = file.content.replace(/\n/g, '');
    if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
      throw new DomainError('Invalid state encoding', 502);
    const bytes = Buffer.from(encoded, 'base64');
    if (
      bytes.length > MAX_CONTENT ||
      bytes.length !== file.size ||
      bytes.toString('base64') !== encoded
    )
      throw new DomainError('Invalid state file size or encoding', 502);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new DomainError('Remote state contains malformed JSON');
    }
    return { state: validatePortableState(parsed), sha: file.sha };
  }

  preview(
    options: { resolution?: 'local' | 'remote'; mode?: 'merge' | 'revert' } = {},
  ): Promise<SyncPreview> {
    return this.run(async (signal) => {
      this.saved = null;
      if (
        !options ||
        typeof options !== 'object' ||
        Array.isArray(options) ||
        Object.keys(options).some((key) => key !== 'resolution' && key !== 'mode') ||
        (options.mode !== undefined && options.mode !== 'merge' && options.mode !== 'revert') ||
        (options.mode === 'revert' && 'resolution' in options) ||
        (options.resolution !== undefined &&
          options.resolution !== 'local' &&
          options.resolution !== 'remote')
      )
        throw new DomainError('Invalid sync preview options');
      const mode = options.mode ?? 'merge';
      const resolution = options.resolution ?? null;
      if (mode === 'revert' && this.store.syncRecord(this.target!).pending)
        throw new DomainError('Cannot revert with an uncertain upload; reconcile it first', 409);
      const { state: remote, sha } = await this.remote(signal);
      const local = this.store.exportState();
      const record = this.store.syncRecord(this.target!);
      if (mode === 'revert') {
        if (record.pending)
          throw new DomainError('Cannot revert with an uncertain upload; reconcile it first', 409);
        if (sha === null)
          throw new DomainError('Revert requires an existing remote state file', 409);
        const preview: SyncPreview = {
          mode,
          previewId: randomUUID(),
          target: { ...this.target! },
          localChanges: changes(local, remote),
          remoteChanges: [],
          conflicts: [],
          validationError: null,
          canApply: true,
          resolution: null,
        };
        this.saved = { preview, local, merged: remote, remote, sha, record };
        return structuredClone(preview);
      }
      let base = record.base ?? emptyPortableState();
      let validationError: string | null = null;
      if (record.pending) {
        if (equal(remote, record.pending.merged)) base = record.pending.local;
        else if (sha !== record.pending.sha)
          validationError =
            'An uncertain upload was followed by remote edits. Restore the uploaded state or the prior remote revision before re-previewing; no automatic overwrite is safe.';
      } else if (!record.base && local.tasks.length && remote.tasks.length) {
        validationError =
          'No common sync baseline. Use an empty local store or a distinct remote path.';
      }
      const result = merge(base, local, remote, resolution);
      validationError ??= result.validationError;
      let merged = result.merged;
      try {
        merged = validatePortableState(merged);
      } catch (error) {
        validationError ??= error instanceof DomainError ? error.message : 'Invalid merged graph';
      }
      if (Buffer.byteLength(JSON.stringify(merged)) > MAX_CONTENT)
        validationError = 'Merged state exceeds 1 MB';
      const preview: SyncPreview = {
        mode,
        previewId: randomUUID(),
        target: { ...this.target! },
        localChanges: changes(local, merged),
        remoteChanges: changes(remote, merged),
        conflicts: result.conflicts,
        validationError,
        canApply: !validationError && (!result.conflicts.length || resolution !== null),
        resolution,
      };
      this.saved = { preview, local, merged, remote, sha, record };
      return structuredClone(preview);
    });
  }

  apply(previewId: string): Promise<SyncStatus> {
    return this.run(async (signal) => {
      const saved = this.saved;
      this.saved = null;
      if (!saved || saved.preview.previewId !== previewId)
        throw new DomainError('Sync preview is stale; re-preview', 409);
      if (!saved.preview.canApply) throw new DomainError('Sync preview cannot be applied', 409);
      if (saved.preview.mode === 'revert' && this.store.syncRecord(this.target!).pending)
        throw new DomainError('Cannot revert with an uncertain upload; reconcile it first', 409);
      if (!equal(this.store.exportState(), saved.local))
        throw new DomainError('Local state changed; re-preview', 409);
      const remote = await this.remote(signal);
      if (remote.sha !== saved.sha || !equal(remote.state, saved.remote))
        throw new DomainError('Remote state changed; re-preview', 409);
      signal.throwIfAborted();
      if (saved.preview.mode === 'revert') {
        this.store.finishSync(this.target!, saved.record, {
          local: saved.local,
          remote: saved.remote,
        });
        return { ...this.getStatus(), syncing: false };
      }
      const record = this.store.prepareSync(
        this.target!,
        saved.record,
        saved.local,
        saved.merged,
        saved.sha,
      );
      if (!equal(saved.remote, saved.merged) || saved.sha === null) {
        // Durable intent precedes the only PUT. Never retry an ambiguous upload automatically.
        try {
          await this.request('writing state file', this.contentPath(), signal, {
            method: 'PUT',
            body: JSON.stringify({
              message: 'Sync FoggyBrain state',
              branch: this.target!.branch,
              content: Buffer.from(JSON.stringify(saved.merged)).toString('base64'),
              ...(saved.sha ? { sha: saved.sha } : {}),
            }),
          });
        } catch (error) {
          if (error instanceof RejectedSyncWrite)
            this.store.restoreSyncRecord(this.target!, record, saved.record);
          throw error;
        }
      }
      signal.throwIfAborted();
      this.store.finishSync(this.target!, record);
      return { ...this.getStatus(), syncing: false };
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.saved = null;
    this.controller?.abort();
    await this.active?.catch(() => {});
  }
}
