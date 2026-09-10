# Semantic Contract

[openapi.json](openapi.json) is the authoritative HTTP reference for routes, parameters, request/response schemas, and status codes. DTO field shapes originate in [src/shared.ts](src/shared.ts); [docs/api.md](docs/api.md) explains maintenance. This contract defines behavioral guarantees that schemas alone cannot express. OpenAPI is documentation, not a runtime validator: the server owns persistence, IDs, validation, and derived completion. Clients must not maintain fallback state or a second completion algorithm.

## Completion And Graphs

A task completes if and only if its own condition and every prerequisite task are complete:

- Manual: `manualDone && (prUrl === null || prState === "merged")`. Marking work done never bypasses an attached PR gate.
- PR: a verified merge. Open or closed-but-unmerged PRs do not satisfy the condition.
- Container: all owned and referenced children complete, with at least one child. **Empty containers remain open.** Containers may be nested and have prerequisites.

`available` means the own condition is unsatisfied with no incomplete prerequisites; `blocked` means it is unsatisfied with incomplete prerequisites. `ready` means the own condition is satisfied but prerequisites remain incomplete; it is not `completed`. Completion is derived, not latched: reopening propagates through prerequisites and shared membership. `waitingOn` identifies incomplete direct prerequisites only.

A task has at most one owning parent, which must be a container. References share the same independently owned task's identity and completion without moving or copying it. Duplicate membership and all effective cycles involving containment, references, and dependencies are rejected. Relationship removals use relationship IDs, not endpoint task IDs; removing a reference unlinks without deleting its target.

Connections link exactly one existing task or atomically create and connect a new one. Prerequisite direction means connected task -> anchor; dependent direction means anchor -> connected task. Without a selected dependency, an ordinary link is added and duplicates fail. Insertion splits only the selected matching edge: `P -> anchor` becomes `P -> connected -> anchor`, or `anchor -> D` becomes `anchor -> connected -> D`. Other edges and existing ownership remain unchanged; existing replacement legs retain their IDs. New task ownership is explicit, not inherited from the anchor. Missing/mismatched edges, self-links, and cycles fail. Creation and all edge changes commit atomically after whole-graph validation, including membership cycles; failures leave no partial changes.

## PR Verification

PR URLs are normalized HTTPS `github.com/{owner}/{repo}/pull/{number}` URLs only. Manual tasks accept an optional PR gate; standalone PR tasks require one and containers reject one. Removing a gate is allowed only for manual tasks. Omitted update fields remain unchanged; PR URL changes or removal reset verification without changing `manualDone`. Polling verifies attached manual gates like standalone PR tasks and must not apply responses for URLs changed or removed during a request.

`prMergeStatus` is informational GitHub gate readiness, separate from task `status`; it never satisfies an own condition. Only REST-verified `prState: "merged"` satisfies a PR gate. Readiness defaults to `unknown` for new tasks and legacy snapshots missing it, is persisted locally, and is excluded from portable state. Imports retain verification/errors only for the same ID, kind, and URL; new identities and changed URLs reset verification. Task mutation APIs do not accept verification fields.

Polling runs only while the server runs. Failures retain last-verified values and report sanitized errors, so completion can reflect stale verification. A non-null `prError` means stale/incomplete verification; `prCheckedAt` is the latest attempt, not necessarily a successful check. A successful GitHub status/refresh HTTP response is not proof that GitHub succeeded: inspect status/error fields. See [PR verification](docs/pr-verification.md) for readiness precedence and partial-failure rules.

## Tags And Favorites

Tags are workspace-scoped. Names are trimmed, nonempty, at most 40 characters, and unique case-insensitively; colors are six-digit hex values. A task may carry at most three custom tags with no duplicate memberships. Every membership references an existing tag.

Favorites is the permanent system tag `favorites` (`Favorites`, `#d4af37`). It is synthesized on every stored-state read and cannot be created, edited, or deleted. Favorites membership does not count toward the custom-tag limit. Whole custom-set replacement preserves Favorites; individual membership operations are idempotent. Deleting a custom tag requires confirmation and atomically strips it from every task.

## Workspaces

Workspace management is always unscoped. Domain requests may use the persisted default or an explicit workspace; **unknown or removed explicit IDs fail without fallback**. Unscoped domain requests return 404 when no default exists, while management and health remain accessible. Workspaces isolate local graphs, layouts, and sync bookkeeping.

The registry permits zero to three workspaces. Existing databases initially remain workspace `default`; new IDs are server-generated. Removing the default assigns the oldest survivor without changing its identity, or leaves no default. An empty registry returns an empty list and null default, stays empty on startup, and never recreates removed workspaces. The first workspace subsequently created becomes the default; the empty UI offers **Add/connect workspace**.

Browser tabs select independently via `?workspace=ID` without changing CLI/server defaults. CLI `--workspace ID` overrides process `FOGGY_WORKSPACE`; with neither, it retains unscoped paths. Keep the same selection for edits and their preview/confirmation or sync preview/apply.

Cloud workspaces remain local-first SQLite graphs, not hosted databases. Create/connect save configuration without remote reads or writes; success does not prove access or import/publish state. Only local-to-cloud connection is supported, not cloud retargeting or demotion. Cloud defaults are branch `main`, path `foggybrain/state.json`, and credential `dedicated`. Sync requires a private repository and existing branch.

Legacy `FOGGY_SYNC_REPO`, `FOGGY_SYNC_BRANCH`, and `FOGGY_SYNC_PATH` initialize or convert only the original `default` if it still exists, preserving its name and data. Conversion uses dedicated credentials and no remote requests. Once cloud, persisted target/credential take precedence; environment changes do not retarget or demote it. Missing `FOGGY_SYNC_TOKEN` does not block startup or local access, but preview/apply fail with a credential error. Malformed supplied tokens and invalid legacy targets remain configuration errors.

## Destructive Operations

Task deletion requires explicit confirmation and should follow review of its deletion preview. It deletes the task and owned descendants, never a target solely because it is referenced; touching dependencies/references are removed and completion recalculated. Preview includes transitively affected external tasks and parent containers as current views, not predicted post-delete statuses. **Task deletion previews are not revision tokens, transactions, or locks**: concurrent edits can change impact before deletion. Re-preview after changes. Unlink a reference when the task should survive.

Workspace removal instead requires explicit confirmation and a current preview revision fingerprint. Preview is local-only and includes counts, dirty status, and blocking reasons. Stale previews and active state sync block removal. The final workspace may be removed. Removal deletes local registration, graph, layouts, sync bookkeeping, unsynced changes, and backups, never GitHub files. Local runtime services stop before database deletion; failed file cleanup is retained durably and retried on startup. Run only one server per data directory; multiple active in-process managers block removal.

Sync apply uses a reviewed, applicable, single-use preview ID and explicit confirmation, with local/remote revalidation as described below. None of these operations should be blindly retried after a timeout: inspect state and re-preview because the write may have committed. Obtain authorization for the reviewed destructive impact; there is no CLI undo.

## Workspace Sync

Manual state sync is separate from PR polling; no background workspace sync runs. Status inspects local configuration/baseline without contacting GitHub. Merge preview computes a three-way merge; conflict resolution chooses only conflicting values, retaining nonconflicting work from both sides. It cannot bypass graph validation or a missing baseline. Inspect both change lists, conflicts, validation errors, and applicability even on successful HTTP responses. Change lists describe proposed changes to each side, not changes since the baseline.

Portable versioned JSON preserves editable task, tag, and relationship identities but excludes layouts, timestamps, derived completion, and PR verification. Version 1 input upgrades in memory to version 2 with no custom tags or memberships; output is always version 2. The canonical Favorites definition is omitted and rejected in portable files, while `favorites` memberships remain valid. Runtime validation checks imported fields, tag memberships, and the whole merged graph using the existing completion/cycle algorithm. Imported PRs must be verified locally; matching local verification follows the identity rules above. Layouts are preserved and cleaned of removed tasks.

SQLite retains a per-target common baseline and pending upload intent across restarts. Each workspace's server-side preview is process-local, replaced on re-preview, and consumed on apply. Apply never creates a preview or retries a remote write; stale local/remote state is rejected. Two nonempty sides without a baseline cannot be automatically reconciled: preserve both rather than wiping data to bypass the guard. Concurrent local edits during upload remain preserved and unsynced. Definitively rejected writes restore prior sync bookkeeping; ambiguous failures retain intent and require a new preview, potentially manual reconciliation. Re-preview after restart, edits, failures, or timeouts.

Concurrent tag deletion versus assignment is represented as a synthetic `tags/{id}/memberships` conflict. Resolving it chooses that side's tag definition and complete membership set as one unit, while retaining ordinary merge results for other fields.

**Revert to origin** is exact local portable graph replacement from the configured target, not a merge, `resolve remote`, or GitHub rollback. Preview freshly fetches an existing valid remote file; a valid empty graph may delete all local tasks, but missing/invalid files never imply clearing state. Revert rejects conflict resolution and reports local changes with no remote changes/conflicts. Uncertain pending uploads block revert until reconciled.

Revert apply uses the server-saved preview mode, refetches and checks the reviewed remote SHA/content, and atomically checks local portable state and sync bookkeeping, backs up the latest full snapshot, replaces the graph, and updates baseline/last-sync time. It never writes GitHub or creates upload intent. Layouts and matching verification follow ordinary import rules. Review and authorize discarded local differences explicitly. Remote state can change after revalidation: replacement uses the reviewed and revalidated revision, not a remote lock.

Sync uses GitHub's Contents API, not a local git CLI/clone; writes use the reviewed file SHA. Full local snapshots are backed up in `foggybrain_sync_backups` before applying sync, with no restore API or pruning. Git history and backups retain deleted sensitive text; deletion is not secure erasure.

## Credentials And Discovery

Credentials stay on the server, never in API responses, task text, command URLs, logs, or committed fixtures. Dedicated sync mode uses only `FOGGY_SYNC_TOKEN`, with no automatic fallback. Explicit `github` mode opts into startup-resolved server `GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token`. Both require Contents read/write on the selected private state repository and applicable organization/SSO approval; prefer a dedicated token to keep PR access read-only. PR access is limited to the token's relevant repositories, not universal access.

Discovery is unscoped, read-only, server-authenticated, no-store, and never changes persistent workspace state. It uses the selected sync credential, not browser credentials. Repository discovery defaults to dedicated and lists only token-visible private repositories owned by the authenticated user, excluding organization/collaborator repositories. Branch/file discovery require explicit credential and target and reverify private ownership. Branches are actual supported branches, with no default auto-selected. File discovery resolves an actual branch and lists safe regular JSON paths from its commit tree, not symlinks, contents, or verified portable states. New safe paths remain valid publication targets; preview verifies remote contents/availability. Discovery never proves write access or sync readiness.

Discovery rejects unsupported/duplicate query fields and unsafe targets. Requests use fixed locally constructed GitHub API URLs, encoded refs, redirect rejection, no remote Link following, and a 15-second overall timeout per operation. Repository/branch pagination is bounded to 10 pages of 100 entries and rejects incomplete results. File discovery rejects malformed/truncated trees, more than 100,000 entries, or more than 2,000 JSON candidates. Missing credentials and sanitized upstream failures remain errors, never empty-success fallbacks; raw payloads and tokens are not exposed. UI selection proceeds repository -> explicitly selected branch -> existing/new path, clearing downstream selections on edits and all selections on credential changes.

The default bind is `127.0.0.1:4173`. This is a trusted local tool, not an authenticated multi-user API. Local Host/Origin protections, including on discovery, are not authorization; do not expose the service publicly. Browser opening passes a validated URL as an argument without a shell. Tests use isolated temporary state and mocked GitHub, never a working database or real GitHub writes.
