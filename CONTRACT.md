# Implementation Contract

The service binds to `127.0.0.1:4173` by default. All endpoints below are prefixed `/api` and return JSON. Errors are `{ "error": "message" }` with a non-2xx status. No tokens in API responses. Types live in `src/shared.ts`.

## Endpoints

- `GET /state`: `Snapshot` with computed task states.
- `POST /tasks`: `CreateTaskInput` -> `TaskView`, status 201.
- `PATCH /tasks/:id`: `UpdateTaskInput` -> `TaskView`.
- `POST /tasks/:id/done`: `{done: boolean}` -> `TaskView`. Manual steps only.
- `GET /tasks/:id/deletion-preview`: `DeletionPreview`.
- `DELETE /tasks/:id?confirm=true`: `{deleted: string[]}`. Reject without confirmation.
- `POST /dependencies`: `{prerequisiteId, dependentId}` -> `Dependency`, status 201.
- `DELETE /dependencies/:id`: `{ok: true}`.
- `POST /references`: `{containerId, taskId}` -> `TaskReference`, status 201.
- `DELETE /references/:id`: `{ok: true}`. Unlinks without deleting the target.
- `PUT /layout`: `Layout` -> `Layout`. `viewId` is a container ID or `root`.
- `GET /github/status`: `GithubStatus`.
- `GET /github/prs`: `GithubPr[]`. Authored open PRs, cached by polling.
- `POST /github/sync`: `GithubStatus`. Fetch immediately; report errors in status.
- `GET /sync/status`: `SyncStatus`. Local workspace sync configuration and baseline status; no remote request.
- `POST /sync/preview`: `{resolution?: "local" | "remote"}` -> `SyncPreview`. Read-only three-way merge preview. Resolution chooses only conflicting values; `canApply`, `conflicts`, and `validationError` must be inspected. Change lists describe proposed changes to each side, not changes since the baseline.
- `POST /sync/apply`: `{previewId: string, confirm: true}` -> `SyncStatus`. Requires a reviewed, applicable, single-use preview. Reject stale local/remote state with 409; never creates a preview or retries a remote write. Re-preview after failures/timeouts because an upload may have committed.

## Core API

`src/core.ts` exports `Store` and `DomainError`. Constructor: `new Store(databasePath: string)` (supports `:memory:`). Methods: `snapshot()`, `createTask(input)`, `updateTask(id,input)`, `setDone(id,done)`, `addDependency(prerequisiteId,dependentId)`, `removeDependency(id)`, `addReference(containerId,taskId)`, `removeReference(id)`, `previewDeletion(id)`, `deleteTask(id)`, `saveLayout(layout)`, `updatePr(id, {state?, checkedAt, error})`, `close()`. `DomainError` exposes `status: number`.

Input validation is required at runtime. A task's own condition is manualDone, PR merged, or all owned + referenced children completed. Empty containers are not complete. A task completes only if its own condition and all prerequisite tasks are complete. An early satisfied condition is ready; incomplete own condition is available or blocked. All completion is derived, so reopening propagates. WaitingOn is incomplete direct prerequisites. Containers may be nested. References add an existing independently owned task as a child; references are not copies. Duplicate membership and all effective cycles (containment + references + dependencies) are rejected. Deleting a task deletes owned descendants, never reference targets, removes touching dependencies/references, and recalculates. Preview includes externally affected tasks, transitively, including parent containers.

GitHub URLs: HTTPS github.com/{owner}/{repo}/pull/{number} only, normalized. PR URL changes reset verified state. Poll errors retain last verified state but set error. Pollers must not apply a response for a URL that has changed in the meantime.

## Workspace Sync

`src/sync.ts` owns manual workspace sync, separate from PR polling. Only a configured private repository and existing branch are accepted. `FOGGY_SYNC_TOKEN` is explicit and dedicated, with Contents read/write access to the state repository; there is no PR-token fallback. GitHub Contents API writes use the reviewed file SHA. Portable state is versioned JSON (`PortableState`), preserving task/relationship IDs but excluding layouts, timestamps, derived completion, and PR verification. The Store validates imported fields and the entire merged graph using the existing completion/cycle algorithm. Existing local PR verification is retained only for matching identities and URLs; imported PRs must be verified locally.

SQLite retains a per-target common baseline and pending upload intent across restarts. The server retains only one process-local preview, replaced on re-preview and consumed on apply. Two nonempty sides without a baseline cannot be automatically reconciled. Concurrent local edits during upload are preserved and remain unsynced; uncertain remote outcomes require a new preview and may require manual reconciliation. Full local snapshots are automatically backed up in `foggybrain_sync_backups` before applying sync; no restore API or pruning is provided. Local layouts are preserved and cleaned of removed tasks. No background workspace sync runs.
