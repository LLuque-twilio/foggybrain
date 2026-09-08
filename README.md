# FoggyBrain

A local task graph for untangling work. Group steps into containers, express prerequisites, share a task across containers, and let a merged GitHub pull request satisfy a step. The web UI and `foggy` CLI use the same running server and the same persisted state.

## Getting Started

Use **Node.js 22, version 22.13.0 or newer** (the server uses Node's built-in SQLite support) and **pnpm 10.14.0**, pinned in `package.json`. If pnpm is not installed, run `corepack enable` with a Corepack-enabled Node installation; Corepack uses the project's pinned version.

```sh
pnpm install
pnpm dev
```

Open **http://127.0.0.1:5173** for the development UI. The API runs at **http://127.0.0.1:4173**; Vite proxies `/api` to it. Leave the development processes running while using the CLI in another terminal:

```sh
pnpm foggy task create "Plan the release" --kind container
pnpm foggy task list
pnpm foggy graph
```

For a built, single-server installation:

```sh
pnpm build
pnpm start
```

The built UI and API are both at **http://127.0.0.1:4173**. `pnpm start` uses the existing build, so rebuild after source changes. An optional global CLI is available after building:

```sh
pnpm link
foggy --json task list
foggy ui
```

`bin/foggy.mjs` loads the compiled CLI; linking does not start a server. If pnpm reports a missing global bin directory, run `pnpm setup` and reopen your terminal before linking. Without linking, use `pnpm foggy <command>`, which runs the CLI source. `foggy ui` opens the configured server URL; for the development UI use `pnpm foggy --url http://127.0.0.1:5173 ui` instead. CLI flags follow `foggy` directly; do not insert an extra `--` separator.

`pnpm-lock.yaml` is the dependency lockfile. Use `pnpm install --frozen-lockfile` for reproducible installs. Dependency build scripts are restricted to `esbuild`, which supports Vite and tsx.

## Workspaces

Keep up to **three independent workspaces** on one server. Each stores its graph in local SQLite. A **local** workspace has no state-sync target; a **cloud** workspace is still local-first, with manual preview/apply sync to a private GitHub repository, not a hosted database or automatic sync service.

```sh
pnpm --silent run foggy --json workspace list
pnpm --silent run foggy --json workspace create "Personal"
pnpm --silent run foggy --json workspace create "Shared" --type cloud --repo OWNER/PRIVATE_STATE_REPO
pnpm --silent run foggy --json workspace rename WORKSPACE_ID "Release planning"
pnpm --silent run foggy --json workspace connect LOCAL_WORKSPACE_ID --repo OWNER/PRIVATE_STATE_REPO
pnpm --silent run foggy --json --workspace WORKSPACE_ID graph
pnpm foggy --workspace WORKSPACE_ID ui
```

Use the IDs returned by the server. `--workspace ID` overrides process `FOGGY_WORKSPACE`; without either, CLI calls retain legacy default-workspace paths. Explicit selection never falls back if the workspace is missing. Workspace management commands always address the unscoped registry. Browser tabs select independently using `?workspace=ID`; switching one does not change another tab or the CLI default.

Existing installations keep their database as workspace `default`, preserving old unscoped API calls and CLI workflows; additional entries receive generated IDs. Keep the data directory across upgrades. Rename is supported for both types; connect converts local to cloud without replacing local tasks. Cloud retargeting and demotion to local are not supported.

Use **Settings > Remove workspace** to review and confirm permanent removal from this device. This deletes local tasks, relationships, layouts, sync history, backups, and unsynced changes, with no undo. The cloud repository and its state file are untouched. You can remove the final workspace. Removing the default makes the oldest remaining workspace the new default, or leaves no default if none remain. Active state sync blocks removal, and changes after preview require a fresh review. Only run one server against a data directory. No CLI removal command is provided.

With no workspaces, `WorkspaceList` returns `workspaces: []` and `defaultWorkspaceId: null`. Restarting the server preserves the empty registry without recreating a workspace. The UI offers **Add/connect workspace** to start again; the first workspace created becomes the default. Unscoped domain API requests return 404 until a workspace exists, while workspace management and health remain accessible. CLI users can run `workspace list` and `workspace create` to recover without restarting.

Cloud setup requires an existing private repository and branch. Defaults are branch `main`, path `foggybrain/state.json`, and credential `dedicated` (`FOGGY_SYNC_TOKEN` on the server). Explicit `--credential github` instead reuses server `GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token`; it requires Contents read/write on the selected private state repository and any organization/SSO approval. Dedicated mode never silently falls back. Prefer a dedicated restricted token to keep PR credentials read-only.

In the UI, **Add workspace > Cloud** and **Connect to cloud** use progressive, same-input search dropdowns: select a repository to automatically load branches, then explicitly select an existing branch to load state paths. No default branch is automatically confirmed. Choose the server credential first: discovery shows only that account's private, token-accessible owned repositories, not browser, organization, or collaborator repositories. Dedicated mode uses only `FOGGY_SYNC_TOKEN`; explicit GitHub reuse uses the server's startup-resolved `GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token`. Changing credentials clears all selections; editing a repository clears branch and path; editing a branch clears path. Use arrow keys and Enter to select, or Escape to dismiss a dropdown.

State paths list safe JSON file candidates from the selected branch, without reading their contents. Filter existing paths or enter a new safe path and select **Use new path** to publish local state. Candidates are not verified FoggyBrain state until sync preview; saving never imports or publishes automatically. Missing credentials, discovery errors, and empty results include retry/guidance. Repository and branch discovery each allow at most 10 pages of 100 entries; incomplete results fail. File discovery rejects truncated trees, trees over 100,000 entries, or over 2,000 JSON candidates. Only sync-supported branch/path names are offered. Discovery does not prove Contents write access or sync readiness.

Open **Settings** to view the selected workspace's name, storage type, repository, branch, state path, and credential mode, or to rename, connect, and add workspaces. Cloud targets remain read-only after connection.

Create/connect API mutations only store configuration, with **no remote reads or writes**; the UI's separate repository discovery performs read-only GitHub requests before saving. After cloud creation or connection, the UI automatically opens and fetches a sync preview. Review the changes and explicitly confirm **Apply sync** to load existing cloud tasks or publish local changes; the graph refreshes after apply. Failed previews leave the connection saved and display an error. For an already-connected workspace, open **Workspace sync** and choose **Preview sync**. Reloading alone does not import remote tasks.

From the CLI, create an empty cloud workspace, then run `--workspace ID sync preview` and apply only after review to fetch existing remote state. To publish local state, connect a local workspace to an unused remote file path, then review/apply. Use the same workspace ID throughout. See [workspace CLI details](docs/cli.md#workspaces) and the safeguards below.

## A Shared Model

- **Manual** tasks have an own condition you set with `task done` or clear with `task reopen`.
- **PR** tasks have an own condition satisfied only by a verified merge. An open PR or one closed without merging is not satisfied. `done` and `reopen` apply only to manual tasks.
- **Containers** have an own condition satisfied when all owned and referenced children complete. **Empty containers stay open.** Containers may be nested.
- A task **completes only when its own condition and every prerequisite are satisfied**. Marking a manual task done early can leave it `ready`, not `completed`.
- `available` means the own condition is unsatisfied and no prerequisite is incomplete. `blocked` means the own condition is unsatisfied and a prerequisite is incomplete. `ready` means the own condition is satisfied but prerequisites are incomplete. `completed` means both checks pass.
- Completion is derived, not latched. Reopening a shared manual task can reopen multiple containers and downstream tasks. `waitingOn` lists incomplete direct prerequisites.

Ownership and references are different. A task has at most one owning parent. A reference makes the **same task**, not a copy, a child of another container without moving it. Both kinds of membership count toward container completion. Duplicate membership and effective cycles involving containment, references, and prerequisites are rejected by the server.

## Using The UI

1. Create a **Container** from the overview, then add manual steps, PR merge gates, or nested containers inside it.
2. Connect a prerequisite's right handle to a dependent's left handle. You can also select a step and use **Add a prerequisite** in its details. Multiple chains and unconnected steps can share a container.
3. Use **Link task** to bring an existing task into a graph without copying it. A referenced container's **Open graph** button navigates to its original graph. The workspace map connects top-level tasks.
4. Select a manual step and choose **Mark own work done**. It becomes Ready if prerequisites are unfinished, otherwise Completed. **Reopen own work** preserves downstream work while recalculating its completion.
5. Layout defaults to automatic. Click **Auto layout** to switch to manual positioning, then drag nodes. Click **Manual layout** to return to automatic arrangement. Manual positions persist per graph.
6. Select a connection to disconnect it. Use **Unlink from this graph** for a shared reference, or delete the original task everywhere after reviewing affected containers and tasks. The UI rechecks deletion impact before confirming.

The UI refreshes server state every four seconds, including changes made by the CLI or other browser tabs. All UI assets, including fonts, are served locally. Pan and zoom the canvas on desktop or touch devices; the node detail panel provides readable task information even when a large graph is zoomed out.

```sh
# Replace IDs below with the IDs returned by the server.
pnpm foggy task create "Release" --kind container
pnpm foggy task create "Tests" --parent CONTAINER_ID
pnpm foggy task create "Deploy" --parent CONTAINER_ID
pnpm foggy dependency add TESTS_ID DEPLOY_ID
pnpm foggy task done DEPLOY_ID
pnpm foggy --json task show DEPLOY_ID
# Deploy is ready until Tests completes.
pnpm foggy task done TESTS_ID
```

## Agents And CLI

The CLI talks to `FOGGY_URL`, defaulting to `http://127.0.0.1:4173`. A global `--url` overrides the environment. It never creates a private local database or silently substitutes mock state if the server is down.

```sh
foggy --url http://127.0.0.1:4173 --json task list --status available
foggy --json task show TASK_ID
foggy --json graph CONTAINER_ID
foggy --json task delete TASK_ID --dry-run
# Review the preview and obtain authorization before confirming:
foggy --json task delete TASK_ID --yes
```

With `--json`, successful commands write one JSON value to stdout. Errors write one `{"error":"message"}` value to stderr and exit nonzero in either output mode. Help remains human-readable text. Use server-returned IDs, not titles or list positions. To avoid pnpm's script banner in JSON pipelines, use **`pnpm --silent run foggy --json <command>`** or the linked `foggy` executable.

Only deletion can prompt, and only on a terminal. Piped/noninteractive deletion requires `--yes`; `--dry-run` never deletes or prompts. The preview lists deleted tasks, affected tasks, and removed relationships. Deletion cascades through **owned descendants**, not reference targets, and removes touching dependencies and references. Other containers and dependents can change completion, including transitively. Unlink a shared child with `reference remove REFERENCE_ID` when you mean to keep the task. There is no CLI undo; previews are not locks against concurrent edits.

See [the CLI reference](docs/cli.md) for every command, output shape, and a runnable branching/shared-task workflow. See [AGENTS.md](AGENTS.md) for repository checks and automation rules.

## GitHub

GitHub is optional; manual tasks and containers do not need a token. Set **`GH_TOKEN` in the server environment**, or put it in a local `.env` file in the repository root before starting the server:

```dotenv
GH_TOKEN=your_token_here
```

The server loads `.env.local` and `.env` from its working directory. Exported environment variables take precedence, then `.env.local`, then `.env`. Restart the server after changes. Both files and other local `.env.*` files are ignored; `.env.example` is the tracked template. Never commit tokens, paste them into task descriptions, or pass them in `--url`. The CLI reads GitHub status from the server; it does not need the token itself.

Use a token restricted to the repositories you intend to track. For a fine-grained token, grant **Metadata: read** and **Pull requests: read** on those repositories. Some repository access paths or organization policies may also require **Contents: read**, SSO authorization, or organization approval. Exact access depends on the account, repositories, and GitHub policy; these permissions are not a promise that every private repository will be visible. Avoid granting write permissions for this read-only integration.

```sh
pnpm --silent run foggy --json github status
pnpm --silent run foggy --json github sync
pnpm --silent run foggy --json github prs
pnpm foggy task create "Merge the fix" --kind pr --pr https://github.com/OWNER/REPO/pull/123
```

PR URLs must be HTTPS `github.com/OWNER/REPO/pull/NUMBER` URLs. `github prs` returns the server's cached **authored open PRs**, not every PR in every repository. Polling runs **only while the server is running**, not while it is shut down and not in a standalone CLI process. `github sync` requests an immediate refresh. Check the returned `configured`, `syncing`, `lastSync`, and `error` fields: a successful HTTP call can still report a GitHub failure in `error`. Poll failures retain the last verified PR state and attach an error; cached data can therefore be stale. Changing a task's PR URL resets its verified PR state.

Authored PR search is bounded by GitHub's 1,000-result limit. Partial or incomplete responses report an error and retain the previous cache rather than silently presenting a truncated list. GitHub Enterprise hosts, deployment verification, and approval/check gates are not implemented in v1.

## Create a Dedicated Sync Token

A dedicated sync token is a GitHub Personal Access Token (PAT) created specifically for FoggyBrain state sync, separate from the read-only token used for PR tracking. Prefer **fine-grained tokens**, not **Tokens (classic)**: fine-grained tokens can limit access to selected repositories, while classic tokens generally need the broader `repo` scope for private repositories.

1. Open **GitHub Settings > Developer settings > Personal access tokens > Fine-grained tokens > Generate new token**, or use [GitHub's token creation page](https://github.com/settings/personal-access-tokens/new). This is not in **SSH and GPG keys**: FoggyBrain uses the GitHub API, not SSH Git authentication or GPG commit signing.
2. Give the token a descriptive name, such as `FoggyBrain state sync`, and choose an expiration you can rotate before it expires.
3. Select the **Resource owner** that owns the state repository. The UI repository picker currently lists user-owned repositories, not organization repositories.
4. Under **Repository access**, choose **Only select repositories** and select your private state repository or repositories.
5. Under **Repository permissions**, grant **Contents: Read and write**. GitHub includes the required **Metadata: Read** permission automatically. No Pull requests write permission is needed. Obtain any required organization approval or SSO authorization.
6. Generate the token and store it only on the server as `FOGGY_SYNC_TOKEN`, either in its process environment or the ignored project-root `.env.local` or `.env`. Do not paste it into chat, task text, commands, URLs, screenshots, or committed files.

```dotenv
FOGGY_SYNC_TOKEN=REPLACE_LOCALLY_WITH_YOUR_FINE_GRAINED_PAT
```

Restart the server, select **Dedicated sync token** in Add workspace or Connect to cloud, and choose your repository. Setting only `FOGGY_SYNC_TOKEN` does not connect a workspace automatically. Repository discovery does not prove write access; review a sync preview before applying changes.

One token can cover multiple workspace files in the same repository. Permissions are repository-wide, not file-specific; use separate repositories when workspaces need different access boundaries. A dedicated token is recommended for ongoing use because it limits the impact of a compromised credential. Explicit GitHub credential reuse remains a convenient alternative if the existing server credential has the required access.

## Manual State Sync

Optional manual state sync shares a versioned task graph through a **private GitHub state repository**, separate from `github sync` PR polling. The server uses GitHub's Contents API, not a git CLI or local clone; writes create commits in the repository's history.

1. Create or choose a dedicated private state repository and an **existing branch** (default `main`). Initialize the repository first if it has no branch.
2. Prefer a dedicated fine-grained token restricted to **only that selected private state repository**, with **Contents: read and write** (and Metadata read). Obtain organization approval if required. Dedicated mode uses `FOGGY_SYNC_TOKEN` without fallback. Alternatively, workspace create/connect with explicit `--credential github` opts into server GitHub credential reuse (`GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token`); that credential must have Contents read/write on the state repository. Reuse is never automatic.
3. Configure credentials in the server environment or ignored `.env`. The legacy target variables below initialize the default workspace or convert an existing local default on restart, preserving its name and data. Once it is cloud, the persisted target and credential take precedence: changing or removing legacy variables does not retarget or demote it. Use workspace create/connect for additional entries. A missing dedicated token does not block startup or local data access; sync preview/apply report a credential error. Malformed supplied tokens and invalid legacy targets remain configuration errors. Never put actual credentials in commands, task text, source, logs, or URLs. Restart after environment changes; the CLI does not load these settings or access the token.

```dotenv
FOGGY_SYNC_REPO=OWNER/PRIVATE_STATE_REPO
FOGGY_SYNC_BRANCH=main
FOGGY_SYNC_PATH=foggybrain/state.json
FOGGY_SYNC_TOKEN=REPLACE_LOCALLY_WITH_DEDICATED_TOKEN
```

4. Inspect configuration and preview changes. These commands do not apply the preview:

```sh
pnpm --silent run foggy --json sync status
pnpm --silent run foggy --json sync preview
```

5. Review `localChanges`, `remoteChanges`, `conflicts`, `validationError`, and `canApply`. A conflicted or blocked preview still exits `0`. If appropriate, request a new preview with `sync preview --resolve local` or `--resolve remote` and review it again. Resolution chooses conflicting values, not a force overwrite, and cannot bypass graph validation or a missing baseline.
6. Only after authorization, apply the exact returned `previewId` from the reviewed preview with `canApply: true`:

```sh
pnpm --silent run foggy --json sync apply REVIEWED_PREVIEW_ID --yes
pnpm --silent run foggy --json sync status
pnpm --silent run foggy --json graph
```

Apply requires `--yes` even on a terminal, never prompts, and never generates a preview. Preview tokens are process-local and single-use; newer previews replace older ones. Re-preview after restart, edits, failures, or timeouts. Never blindly retry a timed-out apply: GitHub may already have accepted the write. Errors or uncertain outcomes may require reconciliation and explicit review, not force.

The UI offers the same review-and-confirm workflow under **Workspace sync** in the sidebar. A delete/edit conflict may remain blocked even after choosing the surviving task if the competing deletion also removed its children or relationships. Reconcile that related structure before re-previewing; choosing a side never bypasses structural validation. A definitively rejected GitHub write restores prior sync bookkeeping so a new preview can reconcile normal contention. Ambiguous failures retain upload intent for recovery.

For first sync, an empty local graph can pull remote state, or a missing remote file can receive local state. Two nonempty sides without a shared baseline are blocked. Preserve both: use a separate new local data directory for a pull or a distinct unused remote path for an independent publication, rather than wiping existing data.

Portable `version: 1` JSON includes editable task fields, dependencies, and references. It excludes PR verification, derived completion, layouts, and timestamps. PR state is reverified locally by server polling. SQLite holds the sync baseline and automatic full local backups in `foggybrain_sync_backups`; there is no restore API or automatic pruning. Keep independent backups. **Git history and local backups retain deleted sensitive information**; deleting a task is not secure erasure. See [manual sync CLI details](docs/cli.md#manual-state-sync) for response fields and recovery safeguards.

## Configuration And Data

The server loads `.env` at startup. Restart it after changing server configuration. The CLI's `FOGGY_URL` comes from its process environment, not from loading `.env` itself.

| Variable                 | Purpose                                                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GH_TOKEN`               | Optional server-side GitHub token; the server also accepts `GITHUB_TOKEN` as a fallback.                                                             |
| `FOGGY_PORT`             | Server port; default `4173`. The server binds to loopback.                                                                                           |
| `FOGGY_DATA_DIR`         | Server data directory; default `~/.local/share/foggybrain`. Contains `foggybrain.sqlite`. Use an explicit absolute path to control where data lives. |
| `FOGGY_POLL_INTERVAL_MS` | GitHub polling interval while the server runs; default `60000` ms, minimum `15000` ms.                                                               |
| `FOGGY_URL`              | CLI server origin; default `http://127.0.0.1:4173`. Overridden by `--url`.                                                                           |
| `FOGGY_WORKSPACE`        | CLI workspace ID from process environment; overridden by `--workspace`. Unset keeps the server default, independently of browser tabs.               |

| Sync variable       | Purpose                                                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FOGGY_SYNC_REPO`   | Legacy default-workspace state target, `owner/repo`; must be private. Additional targets use workspace create/connect.                                                            |
| `FOGGY_SYNC_BRANCH` | Existing target branch; default `main`. Sync does not create branches.                                                                                                            |
| `FOGGY_SYNC_PATH`   | State JSON path in that branch; default `foggybrain/state.json`.                                                                                                                  |
| `FOGGY_SYNC_TOKEN`  | Server token for dedicated mode, Contents read/write restricted to the selected private state repository. No automatic fallback; GitHub reuse requires explicit workspace opt-in. |

For an explicit data location, start the server with, for example:

```sh
FOGGY_DATA_DIR="$HOME/.local/share/foggybrain" pnpm start
```

Keep this directory across upgrades. Stop the server before making a filesystem backup of the data directory so the SQLite database and any WAL files are consistent. Removing local data is not an uninstall step and loses your graph. Build output in `dist/` is not your task database. If you change `FOGGY_PORT`, also set the CLI URL; the development Vite proxy is configured for port `4173` and does not automatically follow a changed server port.

## Security Limits

Foggybrain is a **local, trusted-user tool**, not a multi-user service. Loopback binding reduces exposure but is not authentication or authorization. Other processes/users with access to your machine can reach the API and mutate or delete data; access to the data directory also exposes stored task and repository information. Do not publish the API through a tunnel, reverse proxy, public bind, or shared host without adding appropriate authentication and access controls. Do not rely on browser-origin protections as an API authorization boundary. The GitHub token stays server-side and is not included in API responses, but protecting the server environment and local files remains your responsibility.

## Development Checks

```sh
pnpm test
pnpm typecheck
pnpm build
```

CLI tests spawn the real Commander-based CLI against a fake HTTP server and do not need a running Foggybrain instance or GitHub token. To run just those tests:

```sh
node --import tsx --test src/cli.test.ts
```

Browser tests cover desktop and mobile Chromium using a temporary database and no GitHub credentials:

```sh
pnpm exec playwright install chromium
pnpm test:e2e
```

The browser suite builds the app, starts an isolated server on port `4189`, and removes its temporary data at shutdown. Unit and integration tests mock GitHub; a real token is needed to verify access to your actual repositories.
