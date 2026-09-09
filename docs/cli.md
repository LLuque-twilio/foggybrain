# CLI Reference

`foggy` is a client of a **running** Foggybrain server. It does not poll GitHub itself or maintain fallback local state. Start a server with `foggy start`, or `pnpm dev` for development. The API defaults to `http://127.0.0.1:4173`; the development web UI is `http://127.0.0.1:5173`.

## Invocation

```text
foggy [--url <origin>] [--workspace <id>] [--json] <command>
pnpm foggy [--url <origin>] [--workspace <id>] [--json] <command>
```

The `foggy` executable is available after `pnpm build` and optional `pnpm link`. If pnpm reports a missing global bin directory, run `pnpm setup` and reopen your terminal before linking. `pnpm foggy` runs the TypeScript source without requiring a build. CLI arguments follow `foggy` directly, without an extra `--` separator. In scripts that parse stdout, suppress pnpm's banner:

```sh
pnpm --silent run foggy --json task list
```

| Global flag        | Behavior                                                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--url <origin>`   | Overrides `FOGGY_URL`; otherwise defaults to `http://127.0.0.1:4173`. Use an absolute HTTP(S) origin, optionally with a trailing slash, without a path, credentials, query, or fragment. |
| `--json`           | Print each successful command result as one JSON value followed by a newline. Accepted before or after the subcommand.                                                                   |
| `--workspace <id>` | Overrides process `FOGGY_WORKSPACE` (not loaded from `.env`). Omit both to keep legacy default-workspace API paths.                                                                      |
| `-h`, `--help`     | Human-readable help for the current command, even with `--json`. No server required.                                                                                                     |

The CLI reads `FOGGY_URL` from the process environment, not `.env`. Task and relationship IDs come from server responses and are stable; do not infer IDs from titles, ordering, or UI positions. Quote titles, descriptions, and URLs in your shell. Use the full returned ID.

Success exits `0`. Command-line, validation, transport, and HTTP errors exit `1`, write nothing to stdout, and write a single `{"error":"message"}` JSON object to stderr, **even without `--json`**. Interactive deletion also writes its preview and prompt to terminal stderr before any cancellation/error. There are no progress logs on stdout. Help text is the exception to JSON output. Requests time out after 15 seconds; redirects are rejected rather than silently targeting a different service. Mutations are not retried automatically. After a timeout on a write, inspect state before retrying: the server may already have committed it.

Normal `task list` and `graph` output is a human-readable tab-separated list with IDs, status, kind, JSON-quoted title, and owning parent (`root` for no owner). Normal graph output also lists dependency and reference IDs. All other successful commands already print JSON in normal mode; use `--json` consistently for scripts.

## Workspaces

```text
foggy workspace list
foggy workspace create <name> [--type local|cloud] [--repo owner/repo] [--branch branch] [--path path] [--credential dedicated|github]
foggy workspace rename <id> <name>
foggy workspace connect <id> --repo owner/repo [--branch branch] [--path path] [--credential dedicated|github]
```

The server supports at most **three entries**, each with its own local SQLite graph. Local workspaces have no state-sync target. Cloud workspaces are **local-first**, not hosted databases: edits persist locally and move to/from GitHub only through manual sync. Browser tabs select independently; changing a tab does not change the CLI default or another tab. Keep the same `--workspace ID` (or `FOGGY_WORKSPACE`) across edits, deletion preview/confirmation, and sync preview/apply.

`list` returns `{workspaces, defaultWorkspaceId, limit}`. `defaultWorkspaceId` is a string when a default exists; an empty registry returns `workspaces: []` and `defaultWorkspaceId: null`. Create, rename, and connect return a `Workspace`: `{id, name, type, target, credential}`. Local `target` and `credential` are null; cloud `target` is `{repo, branch, path}`. All management commands print JSON even without `--json` and always use unscoped `/api/workspaces` routes, ignoring global workspace selection. Use server-returned IDs, never names or indexes.

Create defaults to `--type local`; local creation rejects cloud-only flags. Cloud creation and connect require `--repo`, default `--branch main`, `--path foggybrain/state.json`, and **`--credential dedicated`**. Connect converts an existing local workspace to cloud without replacing its graph. Rename works for either type. Cloud retargeting and cloud-to-local demotion are not supported; the server enforces transitions and the entry limit. Local workspace removal is available in UI Settings with preview and confirmation, not through a CLI command. The final workspace can be removed. Removing the default assigns the oldest surviving workspace as the default for unscoped CLI calls, or leaves no default if none remain; explicit removed IDs fail without fallback.

An empty registry remains empty on startup; no workspace is recreated. Unscoped domain requests (task, graph, relationship, GitHub, and sync) return HTTP 404 with the usual CLI error output and exit 1, while workspace management and health remain accessible. Run `workspace create` to create a local or cloud workspace; the first workspace created in the empty registry becomes the default. The empty UI offers **Add/connect workspace**. Clear or replace any explicit removed workspace selection before domain calls; creation does not override `--workspace` or `FOGGY_WORKSPACE`.

The private repository and branch must already exist. Dedicated mode uses server `FOGGY_SYNC_TOKEN` with Contents read/write restricted to the selected private repository. **Only explicit `--credential github` opts into reuse** of server `GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token`; that credential then needs Contents read/write on the private state repository and any organization/SSO approval. Prefer dedicated credentials so PR access stays read-only. The CLI never retrieves or sends tokens.

Creating or connecting only saves configuration: **no remote reads or writes** occur, and success is not proof of access. To fetch existing remote state, create an empty cloud workspace and review/apply its sync preview. To publish a local graph, connect it to an unused remote file path and review/apply. Two nonempty sides without a baseline remain blocked; never wipe either to bypass the guard.

```sh
foggy --json workspace list
foggy --json workspace create "Personal"
foggy --json workspace create "Shared" --type cloud --repo OWNER/PRIVATE_STATE_REPO
foggy --json workspace rename WORKSPACE_ID "Release planning"
foggy --json workspace connect LOCAL_WORKSPACE_ID --repo OWNER/PRIVATE_STATE_REPO --credential dedicated
foggy --json --workspace WORKSPACE_ID sync status
foggy --json --workspace WORKSPACE_ID sync preview
# After reviewing and obtaining authorization:
foggy --json --workspace WORKSPACE_ID sync apply REVIEWED_PREVIEW_ID --yes
foggy --workspace WORKSPACE_ID ui
```

Migration preserves the existing database as workspace `default`; new entries receive generated IDs. Existing CLI invocations without selection use the current persisted default through unscoped endpoints, or fail with 404 when none exists. Explicit selection uses `/api/workspaces/:id/{existing path}` for every task, graph, relationship, GitHub, and sync request; a missing workspace fails without fallback. UI opening uses URL-encoded `?workspace=ID`. Selection flags work before or after subcommands.

## Task Commands

### Create

```text
foggy task create <title> [--kind <kind>] [--parent <id>] [--pr <url>] [--description <text>]
```

- `--kind` is `manual` (default), `container`, or `pr`.
- `--parent` makes the task an **owned** child of an existing container. Omit for a root task; do not pass the word `root` to create.
- `--pr` supplies a required URL for a `pr` task or an optional merge gate for a `manual` task. It does not change the task kind; containers reject it.
- `--description` supplies optional text.

```sh
foggy --json task create "Launch" --kind container
foggy --json task create "Test migrations" --kind manual --parent CONTAINER_ID --description "Exercise rollback too"
foggy --json task create "Merge implementation" --kind pr --parent CONTAINER_ID --pr https://github.com/OWNER/REPO/pull/123
```

Returns a `TaskView`. Server validation enforces kinds, ownership, PR URL validity, and graph rules.

### Connect Or Insert

```text
foggy task connect <id> --direction prerequisite|dependent (--task <id> | --title <title>) [--dependency <id>] [--kind <kind>] [--parent <id>] [--pr <url>] [--description <text>]
```

Connect an existing task (`--task`) or create and connect a new task (`--title`) relative to the anchor task positional ID. Exactly one is required. Creation flags (`--kind`, `--parent`, `--pr`, `--description`) cannot be used with `--task`. New tasks use the same defaults as `task create`: manual kind and root ownership unless `--parent` is supplied; the anchor's parent is not inherited. Existing tasks retain their ownership.

- `--direction prerequisite`: connected task -> anchor.
- `--direction dependent`: anchor -> connected task.
- Without `--dependency`, adds a new leaf connection without changing other branches.
- With `--dependency`, splits that specific relationship. For prerequisite insertion, `P -> anchor` becomes `P -> connected -> anchor`. For dependent insertion, `anchor -> D` becomes `anchor -> connected -> D`. Use the relationship ID from `task show` or `graph`, not a task ID.

```sh
foggy --json task connect ANCHOR_ID --direction prerequisite --task EXISTING_TASK_ID
foggy --json task connect ANCHOR_ID --direction dependent --title "Deploy" --parent CONTAINER_ID
foggy --json task connect ANCHOR_ID --direction dependent --dependency DEPENDENCY_ID --title "Verify deployment"
```

Makes one workspace-scoped `POST /tasks/:id/connections` request and returns the connected existing/new `TaskView`, not the anchor or relationship records. Task creation and all edge changes commit atomically after server validation. Missing/stale edges, mismatched direction, invalid task fields, or cycles fail without partial changes; other branches remain unchanged. Existing replacement legs are reused. Inspect `task show` or `graph` afterward for relationship IDs and derived completion. After a timed-out write, inspect state before retrying; the operation may already have committed.

### List

```text
foggy task list [--parent <id|root>] [--status <status>]
```

With no filters, lists **all** tasks, not just root tasks. Filters combine with AND. `--parent root` selects tasks without an owning parent. `--parent CONTAINER_ID` selects immediate **owned children**, not referenced children; use `task show` or `graph` to see shared membership. A supplied parent ID must identify a container. `--status` accepts `available`, `blocked`, `ready`, or `completed`.

```sh
foggy --json task list
foggy --json task list --parent root
foggy --json task list --parent CONTAINER_ID --status available
foggy --json task list --status ready
```

JSON result: `TaskView[]`, including `[]` when no tasks match. The CLI filters a server `/state` snapshot; it does not compute completion locally.

### Show

```text
foggy task show <id>
```

Returns all task fields, plus:

| Field           | Contents                                                                               |
| --------------- | -------------------------------------------------------------------------------------- |
| `children`      | Immediate owned and referenced children as `TaskView[]`.                               |
| `prerequisites` | Direct prerequisite tasks as `TaskView[]`, including completed prerequisites.          |
| `dependents`    | Direct tasks depending on this task, as `TaskView[]`.                                  |
| `dependencies`  | All dependency records touching the task, including IDs needed for removal.            |
| `references`    | References whose container or target is this task, including IDs needed for unlinking. |

The original `waitingOn` is only the IDs of incomplete direct prerequisites. `childrenIds` includes owned and referenced children. The extra arrays are drawn from the same snapshot. Unknown IDs fail instead of returning an empty success.

### Update

```text
foggy task update <id> [--title <title>] [--description <text>] [--pr <url> | --remove-pr]
```

At least one flag is required. Omitted fields are unchanged. An empty description clears it. Kind, parent, ID, computed status, and PR merge state are not editable here. Updating a PR URL resets verified PR state so a previous merge cannot satisfy a new PR.

```sh
foggy --json task update TASK_ID --title "Verify deployment" --description "Include the canary"
foggy --json task update TASK_ID --description ""
foggy --json task update PR_TASK_ID --pr https://github.com/OWNER/REPO/pull/124
```

Returns the updated `TaskView`.

Use `--pr URL` to attach or replace a manual task's PR gate, or `--remove-pr` to remove it. Removing a gate preserves manual work status and resets PR verification. Standalone PR tasks cannot remove their required gate.

### Done And Reopen

```text
foggy task done <id>
foggy task reopen <id>
```

These commands set or clear **manual work status** (`manualDone`). An attached PR must also be verified merged before the own condition is satisfied. They cannot manually complete containers or PR tasks. Returns the updated `TaskView`.

| Derived status | Meaning                                                    |
| -------------- | ---------------------------------------------------------- |
| `available`    | Own condition false, all prerequisites complete.           |
| `blocked`      | Own condition false, at least one prerequisite incomplete. |
| `ready`        | Own condition true, at least one prerequisite incomplete.  |
| `completed`    | Own condition true, all prerequisites complete.            |

For manual tasks the own condition is `manualDone && (prUrl === null || prState === 'merged')`; for PR tasks it is a verified merge; for containers it is completion of all owned and referenced children. **Empty containers do not satisfy their own condition.** A container can also have prerequisites. Reopening an upstream manual task can make previously completed downstream tasks `ready` and make containing or referencing containers incomplete again. A merged PR's condition stays true, but its task can still wait on prerequisites.

### Delete

```text
foggy task delete <id> [--dry-run] [--yes]
```

Every invocation first fetches the server deletion preview, then a state snapshot for deleted task titles. Preview failure aborts deletion even with `--yes`.

- `--dry-run`: output the preview without mutation or a prompt. Takes precedence over `--yes` if both are supplied.
- `--yes`: explicitly confirm the current cascading deletion without prompting. Required for actual deletion when stdin or stderr is not a TTY. `--json` alone does **not** confirm.
- Neither flag: on a terminal, list IDs and titles of tasks to delete and affected tasks, plus counts of removed dependencies/references, on stderr. Type `yes` to confirm; any other answer cancels with a nonzero exit. With piped input or redirected stderr, return an error rather than reading an answer. Piping `yes` is not supported confirmation.

Dry-run result is the server `DeletionPreview` plus a `tasks` array from the state snapshot:

```text
{
  taskIds: string[],
  tasks: TaskView[],
  affectedTasks: TaskView[],
  removedDependencies: Dependency[],
  removedReferences: TaskReference[]
}
```

`taskIds` is the deletion set: the task and all **owned descendants**. `tasks` supplies their titles and full current task views. `affectedTasks` describes externally affected tasks, including transitive dependents and containing/referencing containers; these are current views, not predicted post-delete statuses. Reference targets are not deleted just because their referring container is deleted; a target is deleted only if it is independently in the owned deletion set. Touching dependencies and references are removed. The remaining graph is recalculated, so tasks can become complete or incomplete.

Confirmed deletion returns `{"deleted":["ID", "DESCENDANT_ID"]}`. There is no CLI undo. Use `reference remove` for unlink-only behavior. A preview is **not a transaction, lock, or durable confirmation token**: concurrent edits can change the deletion impact between preview and DELETE. Avoid concurrent graph writes during a sensitive deletion; re-preview if the graph has changed.

```sh
foggy --json task delete CONTAINER_ID --dry-run
# Only after reviewing taskIds, tasks, affectedTasks, and removed relationships:
foggy --json task delete CONTAINER_ID --yes
foggy --json graph
```

## Dependencies

```text
foggy dependency add <prerequisite> <dependent>
foggy dependency remove <id>
```

The argument order is **prerequisite first, dependent second**: `dependency add A B` means B cannot complete until A completes. This does not create ownership or move tasks. Multiple outgoing edges make branches; multiple incoming edges make a join requiring all prerequisites. The server rejects invalid endpoints, duplicates, and effective cycles.

```sh
foggy --json dependency add DESIGN_ID FRONTEND_ID
foggy --json dependency add DESIGN_ID BACKEND_ID
foggy --json dependency add FRONTEND_ID DEPLOY_ID
foggy --json dependency add BACKEND_ID DEPLOY_ID
foggy --json dependency remove DEPENDENCY_ID
```

Add returns `{id, prerequisiteId, dependentId}`. Remove uses that **dependency record ID**, not either task ID, and returns `{"ok":true}`. Removing a prerequisite edge may allow downstream completion immediately.

## References

```text
foggy reference add <container> <task>
foggy reference remove <id>
```

Reference an existing task, including a container, as a shared child of another container. It retains its owning parent, identity, status, and prerequisites. Membership contributes to the referencing container's own condition. A reference is not a copy and is not a dependency edge. Duplicate owned/reference membership and effective cycles are rejected.

```sh
foggy --json reference add RELEASE_ID SHARED_REVIEW_ID
foggy --json reference remove REFERENCE_ID
```

Add returns `{id, containerId, taskId}`. Remove takes the **reference record ID** and returns `{"ok":true}`; the target task remains. Unlinking may change container completion, and an empty container remains open.

## Graph

```text
foggy graph [container-id]
```

Without an ID, returns the entire graph, including root and nested tasks. With a container ID, includes that container and the transitive closure of its owned **and referenced** children. Shared tasks appear once by ID. An unknown ID or a non-container ID is an error.

JSON shape is `{viewId, tasks, dependencies, references, layouts}`. `viewId` is `root` for the whole graph or the requested container ID. `tasks` contains `TaskView` objects. In a scoped graph, dependency/reference records are included only when **both endpoints** are in scope; layouts are included for in-scope view IDs. Task fields such as `parentId` and `waitingOn` are unchanged and may point outside the scope. Use `task show ID` or an unscoped `graph` to inspect external prerequisites and memberships. The normal human listing includes relationship IDs and directed endpoints as well as tasks.

```sh
foggy graph
foggy --json graph CONTAINER_ID
```

## GitHub

```text
foggy github status
foggy github prs
foggy github sync
```

`status` returns `{configured, login, lastSync, error, syncing}`. `prs` returns cached authored open PRs as `GithubPr[]`, with `url`, `title`, `number`, `repository`, `state`, `draft`, and `updatedAt`. `sync` asks the running server to fetch immediately and returns a status object. Polling does not run when the server is stopped. These commands do not accept tokens; configure `GH_TOKEN` on the server, optionally in its ignored `.env`.

**Inspect `error`, not just the exit code.** A successful HTTP request to status or sync exits `0` even when the returned status reports a GitHub error. HTTP/network failures use the usual stderr error/exit `1` behavior. If `syncing` is true, check status later. PR polling errors retain the last verified merge state and set `prError`; a cached completed PR task is not proof that the latest poll succeeded. `lastSync`, `prCheckedAt`, and error fields help identify stale data.

A large or slow sync can outlast the CLI's request timeout while the server continues working. Check `github status` afterward rather than repeatedly issuing sync requests.

Supported PR URLs are HTTPS `github.com/OWNER/REPO/pull/NUMBER`, normalized by the server. Closed-but-unmerged PRs do not satisfy a PR task. Only a verified merge does. Changing `--pr` resets prior verification.

Use least-privilege token access to relevant repositories: fine-grained Metadata and Pull requests read permissions, with Contents read if required for repository access. Private repositories may additionally need organization approval or SSO authorization. See the [README security and GitHub notes](../README.md); localhost is not an authentication boundary.

## Manual State Sync

This top-level group syncs portable task state with a private GitHub repository, separate from `github sync` PR polling. All commands call the running server API; the CLI never accesses sync tokens, state files, or a local database. See the [server setup workflow](local-guide.md#manual-state-sync).

```text
foggy --json sync status
foggy --json sync preview [--resolve local|remote | --revert]
foggy --json sync apply <preview-id> --yes
```

| Command               | API request                                                                            | Result                                                         |
| --------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `sync status`         | `GET /api/sync/status`                                                                 | `SyncStatus`: `{configured, target, lastSync, dirty, syncing}` |
| `sync preview`        | `POST /api/sync/preview` with `{}` or `{resolution:"local"}` / `{resolution:"remote"}` | `SyncPreview`                                                  |
| `sync apply ID --yes` | `POST /api/sync/apply` with `{previewId:ID, confirm:true}`                             | `SyncStatus`                                                   |

`target` contains `{repo, branch, path}` (or is null in unconfigured status). Status is local inspection, not proof of current remote access or equality. `dirty` compares local portable state with the saved baseline and includes pending reconciliation; `syncing` indicates an active server operation.

A preview returns `previewId`, `mode` (`merge` or `revert`), `target`, `localChanges`, `remoteChanges`, `conflicts`, `validationError`, `canApply`, and `resolution`. Changes describe what would change on each side, with `collection`, `id`, optional `title`, and `kind` (`added`, `updated`, `deleted`). Conflicts include `path`, `base`, `local`, and `remote`. **A preview with conflicts or validation errors is successful inspection: exit `0` is not permission to apply.** Review both change lists, all conflicts, `canApply`, and `validationError` before authorization.

### Revert To Origin

`sync preview --revert` sends `{mode:"revert"}` and freshly fetches the configured repository, branch, and path. Unlike `--resolve remote`, it proposes discarding all local differences and replacing tasks and relationships exactly with remote state. It never writes to GitHub. The file must exist and contain valid portable state; a valid empty graph can remove all local tasks. Missing files and uncertain pending uploads block revert. `--revert` and `--resolve` are mutually exclusive.

```sh
foggy --json --workspace WORKSPACE_ID sync preview --revert
# Review localChanges and obtain authorization to discard local changes:
foggy --json --workspace WORKSPACE_ID sync apply REVIEWED_PREVIEW_ID --yes
```

Apply refetches and checks the reviewed revision, rejects concurrent local changes, and atomically backs up the full local snapshot before replacement and baseline update. Layouts and matching PR verification are preserved using normal import rules. A new preview replaces the old one; apply consumes it. After failures/timeouts, inspect state and re-preview, because local replacement may already have committed. The UI exposes the same flow through **Workspace sync > Revert to origin**. This restores from GitHub, not from a local backup.

`--resolve local` or `--resolve remote` chooses that side for conflicting values while retaining nonconflicting changes from both sides. It creates a new preview, not a whole-state replacement or force override. Conflicts remain visible even when resolved. Invalid merged graphs and missing common baselines still block apply.

```sh
foggy --json sync status
foggy --json sync preview
# Only if appropriate, choose a conflict side and review the NEW preview:
foggy --json sync preview --resolve remote
# After approval, use the exact previewId from the reviewed, applicable preview:
foggy --json sync apply REVIEWED_PREVIEW_ID --yes
foggy --json sync status
foggy --json graph
```

Apply always requires explicit `--yes`, even on a terminal. Without it, the CLI fails before any API request and never prompts. `--json` and piped input are not confirmation. Apply never generates a preview automatically. The backend also rejects missing confirmation, stale previews, changed local/remote state, and previews that cannot apply.

Preview IDs are process-local, single-use tokens, not durable approvals. A newer preview replaces the previous one, and an apply attempt consumes it. Re-preview after server restart, edits, failures, or timeouts. **Do not retry a timed-out apply blindly:** the remote write may have committed even if the response was lost. Inspect status and a fresh preview; uncertain outcomes followed by remote edits may require careful reconciliation, not force. Preserve both versions and obtain approval before recovery edits.

On first sync, an empty local graph can pull existing remote state, or a missing remote file can receive local state. If both sides are nonempty without a shared baseline, apply is blocked even with `--resolve`. Preserve existing data: use a separate new local data directory to inspect/pull remote state or a distinct unused remote path to publish an independent graph. Do not wipe either side to bypass the guard.

The versioned JSON (`version: 1`) contains editable task fields and dependency/reference records, not PR verification, derived completion, layouts, or timestamps. PR state is reverified locally by server polling; remote JSON cannot assert a verified merge. The server persists its baseline in SQLite and makes automatic full local backups in `foggybrain_sync_backups`. There is no restore API or automatic backup pruning. Keep independent database backups too. GitHub Contents API writes create Git history without a local git CLI or clone; deleting sensitive text from current state does not remove it from history or backups.

### Diagnosing Failures

Use the returned workspace ID to inspect the same workspace that failed:

```sh
foggy --json workspace list
foggy --json --workspace WORKSPACE_ID sync status
foggy --json --workspace WORKSPACE_ID sync preview
```

Status reads local configuration and baseline bookkeeping only; it does not contact GitHub or retain the last error. Preview reads GitHub without changing either graph or writing a remote file, but replaces the previous process-local preview. Inspect both change lists, `conflicts`, `validationError`, and `canApply`. A successful preview cannot verify write permission or prove that an earlier upload succeeded. Do not use apply as a diagnostic probe.

Request failures name the phase (`reading repository`, `reading branch`, `reading state file`, or `writing state file`) and upstream HTTP status when available. HTTP 401 suggests checking credential validity/expiry; 403 suggests permissions, organization/SSO approval, rate limits, or branch rules; 404 suggests checking the target and private-resource access. A missing state-file GET 404 remains normal bootstrap behavior, not an error. HTTP 409 requires a fresh reviewed preview; 422 also calls for checking the target and branch rules. For 429 or 5xx, wait and check rate limits or GitHub service health before re-previewing. These are static diagnostic suggestions, not a definitive explanation from GitHub.

Timeouts identify the server's overall 10-second sync deadline; transport failures suggest checking the server's network, DNS, TLS, and proxy connectivity. Messages intentionally omit upstream bodies, status text, URLs, tokens, and raw exceptions. After a write failure, never blindly retry: the upload may have committed, and retained upload intent may require reconciliation. Obtain authorization before applying a newly reviewed preview.

Credentials are server-only: dedicated mode uses only `FOGGY_SYNC_TOKEN` (without fallback); explicit `github` mode uses server `GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token`. Both require access to the selected private repository, Contents read/write for publishing, and any organization/SSO approval. Prefer dedicated sync credentials to keep PR access read-only. Never put tokens in CLI arguments, task text, diagnostic reports, or logs. This sync uses the GitHub Contents API, so local git remotes and git CLI tracing do not diagnose its requests.

## Installation And Upgrades

```text
foggy upgrade [--version <version>] [--force]
foggy link [--version <version>] [--force]
foggy uninstall [--yes]
```

These commands manage a curl-installed FoggyBrain under `~/.foggybrain` (override with `FOGGY_HOME`). They are not used by a `pnpm link --global` development install.

`foggy upgrade` resolves the latest GitHub release (or `--version`), downloads `SHA256SUMS` and `foggybrain-<version>.tar.gz` from that release, aborts unless the archive's SHA-256 matches its `SHA256SUMS` entry (the same check `scripts/install.sh` makes), extracts it to `~/.foggybrain/versions/<version>/`, repoints `~/.foggybrain/current` and `~/.local/bin/foggy`, and returns `{"version":"...","path":"...","bin":"...","pathEntry":"present","previousVersion":"..."}`. Old version directories are kept for rollback; remove them with `rm -rf ~/.foggybrain/versions/<old>`. A server started before the upgrade keeps running the old code out of its still-present version directory, so restart it with `foggy stop && foggy start`.

`foggy link` performs only the symlink and `PATH` steps for an already-extracted version, defaulting to the running CLI's own version. Use it to roll back: `~/.foggybrain/versions/<old>/bin/foggy.mjs link`. `pathEntry` is `created` when the `PATH` entry had to be written (`/etc/paths.d/foggy` on macOS, which prompts for `sudo`; a marked line in `~/.profile` on Linux), `present` when it was already correct, and `failed` when writing it did not work — a declined or unavailable `sudo`, typically. `failed` is not a failed install: the version is linked and `~/.local/bin/foggy` works, and the command prints the one line to add yourself before exiting `0` (naming `~/.zprofile` on macOS, since zsh never reads `~/.profile`, and `~/.profile` on Linux).

`link` and `upgrade` refuse to replace a `~/.local/bin/foggy` that is not a symlink into the install root — a `pnpm link --global` executable, or any other shim — and name what it points at. This is the same notion of ownership `uninstall` uses. Pass `--force` to replace it and take over the name.

`foggy uninstall` stops a running server, removes `~/.local/bin/foggy`, removes the `PATH` entry (`sudo rm -f /etc/paths.d/foggy` on macOS, the marked `~/.profile` line on Linux), and deletes `~/.foggybrain` including every kept version. It returns `{"removed":[...],"pathEntry":"removed","keptDataDir":"..."}`. If `~/.local/bin/foggy` is not a symlink into the install root — a `pnpm link --global` executable or a shell shim, for example — this is a foreign install and `uninstall` does nothing at all: it reports `removed: []` and the PATH entry's real state (`"present"` or `"absent"`) without touching it. **Task data is kept**: `~/.local/share/foggybrain` (SQLite state and config) is never touched, so reinstalling restores the same workspaces. Delete that directory by hand to remove your data. Without a terminal, `--yes` is required; with one, the command prompts and expects `yes`.

## Server Lifecycle

```text
foggy start
foggy stop
```

`foggy start` spawns the server detached, waits for it to answer `/api/health`, writes its process ID to `foggy.pid` in the data directory (`FOGGY_DATA_DIR`, default `~/.local/share/foggybrain`), and returns `{"pid":12345,"url":"http://127.0.0.1:4173","dataDir":"..."}`. Server output goes to `foggy.log` in the same directory, truncated on each start. If the server exits during startup or never answers within twenty seconds, `start` kills it, writes no pidfile, and fails with the exit status and the tail of `foggy.log`; a port already in use is the usual cause. A child that dies is a failure even when the port answers, since the answer is then another process's. Starting twice is an error while the recorded process is alive; a stale pidfile is ignored. `FOGGY_PORT` selects the port; `--url` / `FOGGY_URL` do not, since they configure the client, not the server.

`foggy stop` sends `SIGTERM` to the recorded process, waits up to five seconds for it to exit, and removes the pidfile. With no server recorded it returns `{"stopped":false,"pid":null}` and exit `0`.

## Dashboard

```text
foggy dashboard
```

Opens the configured origin in your default browser using `open` on macOS, `rundll32.exe` on Windows, or `xdg-open` on other platforms. The URL is passed as an argument without a shell. No server is started or probed. Success means the opener exited successfully, not that the browser rendered the page. Result: `{"url":"http://127.0.0.1:4173/","opened":true}`. A missing/failing platform opener is an error; headless agents should use API commands instead.

```sh
foggy dashboard
foggy --url http://127.0.0.1:5173 dashboard  # Development UI
foggy --workspace WORKSPACE_ID dashboard  # Opens /?workspace=WORKSPACE_ID
```

## Agent Workflow

This POSIX-shell example uses optional `jq` for JSON extraction and assumes a linked `foggy` and a running server. Without linking, replace each `foggy` with `pnpm --silent run foggy`. Store returned IDs and quote expansions. This creates real persisted tasks, not a simulation.

```sh
set -eu

release=$(foggy --json task create "Release" --kind container | jq -er '.id')
build=$(foggy --json task create "Build" --kind container --parent "$release" | jq -er '.id')
review=$(foggy --json task create "Shared security review" | jq -er '.id')
design=$(foggy --json task create "Design" --parent "$build" | jq -er '.id')
frontend=$(foggy --json task create "Frontend" --parent "$build" | jq -er '.id')
backend=$(foggy --json task create "Backend" --parent "$build" | jq -er '.id')
deploy=$(foggy --json task create "Deploy" --parent "$release" | jq -er '.id')

# A branch and a join. The prerequisite is always the first argument.
foggy --json dependency add "$design" "$frontend"
foggy --json dependency add "$design" "$backend"
foggy --json dependency add "$frontend" "$deploy"
foggy --json dependency add "$backend" "$deploy"
foggy --json dependency add "$review" "$deploy"

# One independently owned task contributes to two containers.
foggy --json reference add "$build" "$review"
release_reference=$(foggy --json reference add "$release" "$review" | jq -er '.id')

# Early satisfaction does not bypass prerequisites: Deploy becomes ready.
foggy --json task done "$deploy"
foggy --json task show "$deploy"
foggy --json task list --status available

foggy --json task done "$design"
foggy --json task done "$frontend"
foggy --json task done "$backend"
foggy --json task done "$review"
foggy --json graph "$release"  # The release can now complete.

# Reopening a shared task invalidates completion across both containers.
foggy --json task reopen "$review"
foggy --json task show "$deploy"  # Ready again, waiting on review.
foggy --json task done "$review"

# Unlinking removes membership, not the shared task.
foggy --json reference remove "$release_reference"
foggy --json task show "$review"

# Preview first. This does not delete or prompt.
foggy --json task delete "$release" --dry-run
```

Stop after the preview and review **every deleted ID/title, external affected task, and removed relationship** with the person authorizing the deletion. Do not treat an earlier generic request to inspect the graph as authorization. After approval and with no intervening graph changes:

```sh
foggy --json task delete "$release" --yes
foggy --json task show "$review"  # Independently owned reference target survives.
foggy --json graph
```

For ordinary work: inspect `graph`/`task show`, choose `available` work, perform the work, mark manual tasks done, then inspect the derived status and any `waitingOn` IDs. `ready` is not actionable unfinished work; its own condition is already satisfied. Do not force a PR task done or invent a replacement task when GitHub is unavailable. Check status/error fields and report the blocker.

## Data Shapes

`TaskView` includes `id`, `title`, `description`, `kind`, `parentId`, `manualDone`, `prUrl`, `prState`, `prCheckedAt`, `prError`, `createdAt`, `updatedAt`, `status`, `ownSatisfied`, `waitingOn`, and `childrenIds`. Nullable fields are returned as JSON `null`, not empty IDs. The CLI forwards server-created and server-computed fields rather than synthesizing completion or IDs.

Authoritative TypeScript shapes are in [`src/shared.ts`](../src/shared.ts); the generated [`openapi.json`](../openapi.json) is the HTTP reference, and [`CONTRACT.md`](../CONTRACT.md) defines semantic guarantees. See the [API maintainer guide](api.md) for generation and validation boundaries. Task create/update/done/reopen return the server `TaskView`; relationship additions return the server relationship record; removal results and GitHub payloads are passed through unchanged. Consumers should use named fields and relationship IDs rather than depending on array ordering.
