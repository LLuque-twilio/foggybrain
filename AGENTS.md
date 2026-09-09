# Working In FoggyBrain

Read `openapi.json`, `CONTRACT.md`, and `src/shared.ts` before changing API consumers or domain behavior. The generated spec is the HTTP reference; the contract defines semantic guarantees. The server owns persistent state, IDs, validation, and derived completion. Do not implement a second completion algorithm or fallback local state in the CLI or UI.

## Setup And Checks

`foggy setup` is a human-operated TTY-only configuration wizard; never drive it through agent tools on the user's real HOME. `--json`, explicit URL routing, and workspace selection are rejected with structured errors and no prompts. It only edits `~/.config/foggybrain/.env` after explicit review, with hidden token input, atomic 0600 saving, a 0700 directory, symlink rejection, concurrent-edit detection, and a conservative `.setup.lock` (no automatic stale reclamation). Keep preserves credentials; replacement uses canonical `GH_TOKEN`, removing `GITHUB_TOKEN`; dedicated `FOGGY_SYNC_TOKEN` is separate and removal deletes its entry. Process overrides are warned by name only and never saved. Data remains `~/.local/share/foggybrain` by default, logs/runtime `~/.local/state/foggybrain`; an absolute data override selects another database without migration/deletion. Legacy default sync targets stay unchanged by default and cannot retarget persisted cloud workspaces. No network, server startup/stop, or workspace writes occur. Completion instructs the user to run user-wide `foggy stop`, then a default API command/dashboard to load configuration, without an automatic restart. Test only with isolated HOME and simulated terminals.

Use Node.js 22, at least `22.13.0`, and pnpm 10.14.0 as pinned in `package.json`. Install dependencies with `pnpm install` (or `pnpm install --frozen-lockfile` for reproducible installs). Maintain `pnpm-lock.yaml`; do not create competing lockfiles. Dependency build scripts are allowlisted for `esbuild` only.

```sh
pnpm test
pnpm typecheck
pnpm build
```

Run all three checks after changes and report failures accurately. `pnpm test` runs `src/*.test.ts` with Node's test runner through `tsx`. For focused CLI regression tests:

```sh
node --import tsx --test src/cli.test.ts
```

For UI changes, run `pnpm test:e2e` as well (install Chromium with `pnpm exec playwright install chromium` once). It builds the app and starts an isolated server on port `4189` with temporary storage and blank GitHub credentials. Tests cover desktop and mobile Chromium. Never point browser tests at the user's working database.

CLI tests use subprocesses and a fake HTTP server. They require neither a live application server nor a GitHub token. Test the real Commander invocation, stdout/stderr, and exit codes, not just mocked command handlers. The CLI can be imported without running commands; preserve the entry guard and support for `bin/foggy.mjs` importing the compiled CLI.

For manual integration work, `pnpm dev` starts the API on `127.0.0.1:4173` and the development UI on `127.0.0.1:5173`. For the built app, `pnpm build && pnpm start` serves both API and UI on `127.0.0.1:4173`. `pnpm start` does not rebuild. Default CLI API commands auto-start/reuse the local server; only explicit `--url`/process `FOGGY_URL` targets require a separately running server. `foggy dashboard` starts/reuses and opens the built UI; `foggy ui` remains opener-only with no startup/probe. Stop legacy incompatible servers and restart once with the new installation; never kill an unknown listener. Use an explicit absolute temporary `FOGGY_DATA_DIR` and isolated configuration for manual experiments rather than mutating a user's real graph. Only run one server per data directory. The dev Vite proxy targets `4173` and does not follow a changed `FOGGY_PORT` automatically.

`foggy --json stop` gracefully stops all registered APIs/built dashboards for the current user across ports and data directories, including new foreground APIs. It never autostarts, signals PIDs, or contacts HTTP origins; explicit `--url`/`FOGGY_URL` is rejected and workspace selection does not narrow its scope. Private per-instance runtime records under `~/.local/state/foggybrain/instances` require live identity verification on a separate loopback control connection. Inspect `stopped` and `ignored`; stale/unrecognized records are left untouched, and uncertain shutdowns fail without force-killing. Discovery is a snapshot. Old unregistered servers, browser tabs, Vite, and watchers are not stopped; Ctrl-C the development terminal for the full stack. Never run stop against the user's real HOME during tests: isolate HOME as well as data/configuration. No database layout or migration is involved.

End-user installation is `brew install LLuque-twilio/tap/foggybrain` on macOS/Linux, then optional human-operated `foggy setup` and `foggy dashboard`. Homebrew manages `node@22` and npm internally; users need no separate Node/pnpm setup, checkout, or source build. The public https://github.com/LLuque-twilio/homebrew-tap is set up, but no app release is published yet: installation is unavailable until the first release is published and its formula merged into the tap. No formula goes live before that real release. Upgrades require an explicitly authorized user-wide `foggy stop`, then `brew upgrade LLuque-twilio/tap/foggybrain` and restart, preserving configuration and all data. No Homebrew service, sudo, or `curl | sh` installer; the CLI owns managed lifecycle. Do not add direct npm, nvm, custom PATH, or user-prefix walkthroughs for normal users.

Contributor setup stays in CONTRIBUTING: `pnpm install --frozen-lockfile` and `pnpm pack` (its `prepack` hook runs `pnpm build`). Homebrew consumes the prebuilt `foggybrain-X.Y.Z.tgz` from https://github.com/LLuque-twilio/foggybrain/releases. Run `pnpm test:package` to pack and test the actual archive, or pass an existing archive path to test without rebuilding. It requires npm registry access but isolates HOME, npm prefix, configuration, and data storage. Runtime dependencies are fetched through npm internally; the archive checksum verifies the artifact, not a transitive dependency lock. The tag-triggered release workflow checks and tests the archive on Linux/macOS, generates `foggybrain.rb` from its SHA-256 via `scripts/homebrew.mjs`, and attaches it with the tgz and `SHA256SUMS` to a draft. Maintainers review and publish the draft, then manually open a tap PR adding/updating `Formula/foggybrain.rb`, with no cross-repository bot token. Compare formula URL, checksum, and version against the published release and require passing release and tap checks before merging. Tap CI will install/test the formula on macOS/Linux. Keep `private: true`; no npm publish. The package allowlist includes bin, dist, README, LICENSE, CONTRACT, openapi, and docs, excluding compiled test JS. Inspect actual tarball contents when changing packaging. Do not globally install on the user's machine without authorization.

For API changes, regenerate `openapi.json` with `pnpm openapi:generate` and run `pnpm openapi:check` as well. Never hand edit the artifact. DTO field shapes come from `src/shared.ts`; `scripts/openapi.ts` owns route metadata and focused conditional schema refinements. The spec is not a runtime validator. See `docs/api.md` for ownership and contract-test coverage, and `docs/pr-verification.md` for PR readiness precedence.

## Agent CLI Usage

Use source execution with quiet pnpm output, or the Homebrew-installed `foggy` (optional `pnpm link` after building is for checkout-linked development). Run `pnpm build` once before managed server startup from source, and rebuild after server/UI changes. For a separately running development API, use `--url http://127.0.0.1:4173` to bypass managed startup; see CONTRIBUTING:

```sh
pnpm --silent run foggy --json graph
pnpm --silent run foggy --json task list --status available
pnpm --silent run foggy --json task show TASK_ID
```

Default API commands use `http://127.0.0.1:4173`, following configured `FOGGY_PORT`. Global `--url` overrides process `FOGGY_URL`; either explicit origin bypasses auto-start even for loopback. Managed startup loads `~/.config/foggybrain/.env`, overridden by process environment, never the invoking directory's dotenv files. Data defaults to `~/.local/share/foggybrain`; managed relative `FOGGY_DATA_DIR` resolves against `~/.config/foggybrain`. Foreground `pnpm start`/`pnpm dev` retain cwd `.env.local` then `.env` loading below process environment precedence. Restart to change server configuration; reuse does not reload it. CLI `FOGGY_URL` and `FOGGY_WORKSPACE` are process-only, not dotenv routing settings.

Use `--json` for every machine-consumed command. Human mode writes a connection notice on stderr; JSON mode suppresses it. Success is one JSON value on stdout and exit `0`; failures are one `{"error":"message"}` on stderr, empty stdout, and exit `1`. `--help` remains plain text. Ordinary `pnpm foggy` adds pnpm's banner, so do not parse that stdout as JSON. Place `--silent` before `run` and CLI arguments after `foggy`, without an extra `--` separator. Never assume a successful GitHub status/sync call means GitHub succeeded: inspect `error`, `configured`, and `syncing`.

Use IDs returned by the server, never titles, list indexes, or guessed IDs. A task ID identifies a task; dependency and reference removals require their separate relationship IDs. See `docs/cli.md` for every supported flag and a branching/shared-reference workflow.

```sh
foggy --json task create "Implement the change" --kind manual --parent CONTAINER_ID
foggy --json dependency add PREREQUISITE_ID DEPENDENT_ID
foggy --json reference add CONTAINER_ID EXISTING_TASK_ID
foggy --json task done MANUAL_TASK_ID
foggy --json task show MANUAL_TASK_ID
```

`task done` satisfies only manual work (`manualDone`). Manual tasks may also have an optional PR gate (`task create/update --pr URL`); their own condition requires both manual work done and a verified merge. `task update ID --remove-pr` removes only an optional manual gate, preserving manual work status. `ready` means own condition satisfied but blocked from completion by prerequisites; it is not `completed`. `available` means unfinished own work without incomplete prerequisites; `blocked` means unfinished own work with incomplete prerequisites. A PR task requires a verified merge. A container requires all owned and referenced children to complete; **empty containers remain open**. Reopening propagates through dependencies and shared memberships. Containment, reference, and dependency cycles are invalid. References share identity and completion without changing ownership.

`task list --parent ID` shows immediate owned children only. `task show ID` includes referenced children and direct prerequisites/dependents. `graph ID` scopes to a container and transitive owned/referenced children; only relationships with both endpoints in scope appear, so use unscoped `graph` or `task show` to inspect external edges.

## Workspace Selection

Start with `foggy --json workspace list` and use returned IDs. At most three entries exist; each has independent local SQLite state. Cloud workspaces are local-first with manual sync, not hosted state. `--workspace ID` overrides process `FOGGY_WORKSPACE`; omit both to preserve legacy default-workspace API paths. Explicit selected requests use `/api/workspaces/:id/{existing path}` with no fallback. Keep the same workspace selection for every edit, deletion preview/confirmation, and sync preview/apply. Browser tabs select independently via `?workspace=ID`; neither changes CLI defaults. `foggy --workspace ID ui` opens that query parameter.

Management is always unscoped: `workspace list`, `workspace create NAME [--type local|cloud]`, `workspace rename ID NAME`, and `workspace connect ID --repo OWNER/REPO`. Cloud create/connect require a private repo and existing branch, defaulting to `--branch main --path foggybrain/state.json --credential dedicated`. Connect only converts local to cloud; no cloud retargeting or demotion is supported. Existing databases initially remain workspace `default`; new IDs are server-generated. Create/connect only save configuration, never read/write remote state. Review/apply a scoped sync preview to fetch existing remote or publish local state; do not confuse configuration success with verified access.

Settings supports permanent local workspace removal, not a CLI command. Preview with `GET /api/workspaces/:id/removal-preview`, review impact, and obtain authorization before `DELETE /api/workspaces/:id?confirm=true` with the reviewed `{revision}`. Removal deletes local data including unsynced changes and backups, never cloud files. The final workspace can be removed; removing the default assigns the oldest survivor as default for unscoped calls, or leaves no default when none survive. Explicit removed IDs fail without fallback. Active state sync blocks removal. Re-preview after edits or failures; never retry a timed-out deletion blindly. Only run one server per data directory.

An empty registry returns `WorkspaceList` with `workspaces: []` and `defaultWorkspaceId: null` and stays empty on startup; no workspace is recreated. Unscoped domain requests return 404 when no workspace exists, while workspace management and health remain accessible. The empty UI offers **Add/connect workspace**; the first workspace created in the empty registry becomes the default. From the CLI, use `workspace create` (local or cloud), then use its returned ID.

## Destructive Operations

Never try to answer an interactive prompt from an agent. Always preview deletion, review impact, obtain appropriate authorization, then explicitly confirm:

```sh
foggy --json task delete TASK_ID --dry-run
# After approval and without intervening graph edits:
foggy --json task delete TASK_ID --yes
foggy --json graph
```

Without `--yes`, actual deletion fails when stdin or stderr is not a TTY. `--json` is not confirmation; piping `yes` is not confirmation. `--dry-run` never deletes, even with `--yes`. Review `taskIds`, `tasks` (IDs/titles), `affectedTasks`, `removedDependencies`, and `removedReferences`. Deletion removes owned descendants, never a reference target solely because it was referenced, and can change completion of external tasks transitively. Use `reference remove REFERENCE_ID` to unlink without deleting the shared task. No CLI undo exists. Preview and deletion are separate requests, not a lock; re-preview after concurrent changes. Do not retry timed-out writes blindly because they may already have committed.

## Secrets And Boundaries

`foggy --json --workspace ID sync preview --revert` previews **Revert to origin**: exact local graph replacement from the configured GitHub branch/path, never a GitHub write. Inspect `mode`, target, all `localChanges`, and `canApply`, obtain authorization to discard local differences, then use the same workspace for `sync apply REVIEWED_PREVIEW_ID --yes`. Do not confuse this with `--resolve remote`, which merges nonconflicting local work. Missing/invalid remote files and uncertain pending uploads block revert; an existing valid empty graph can delete all local tasks. Apply revalidates the remote revision and local state, creates a full local backup, and updates the baseline atomically. Never retry a timed-out revert blindly; inspect state and re-preview.

Manual state sync is the top-level `sync` group, not `github sync` PR polling. Use `foggy --json sync status` then `foggy --json sync preview`; inspect both change lists, `conflicts`, `validationError`, and `canApply`, even on exit `0`. Obtain authorization before `foggy --json sync apply REVIEWED_PREVIEW_ID --yes`. Apply never prompts or creates a preview. `--resolve local|remote` chooses conflicting values in a new preview, not a force override. Preview IDs are process-local, single-use, and replaced by newer previews. Re-preview after restart, edits, failures, or timeouts; never retry a timed-out apply blindly because a remote write may have committed. Uncertain outcomes may need reconciliation. With no shared baseline and two nonempty sides, preserve both; do not wipe data to bypass the guard.

Sync credentials belong only on the server. Dedicated mode (the safe default) uses `FOGGY_SYNC_TOKEN` without fallback. Only explicit `--credential github` opts into server `GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token` reuse. Either mode needs Contents read/write on the selected PRIVATE state repository and any organization/SSO approval; prefer dedicated credentials to keep PR access read-only. Legacy `FOGGY_SYNC_REPO`, `FOGGY_SYNC_BRANCH`, and `FOGGY_SYNC_PATH` configure the default target; additional workspace targets use management commands. Never perform real GitHub writes for tests. Sync uses the Contents API, not a local git CLI/clone. Portable versioned JSON excludes verification, derived completion, layouts, and timestamps; PRs are reverified locally. SQLite stores the baseline and automatic full backups in `foggybrain_sync_backups`, with no restore API or pruning. Git history and backups retain deleted sensitive text.

`GH_TOKEN` belongs in the server environment or ignored `.env`, never source, task text, command URLs, logs, or committed fixtures. Fine-grained token access should be read-only and limited to relevant repositories: Metadata and Pull requests read, Contents read if required, plus any organization/SSO approval. Do not claim universal repository access. GitHub polling runs only while the server runs; poll errors can leave stale last-verified PR state. Report stale/error conditions rather than inventing successful syncs.

The app is a trusted local tool, not an authenticated multi-user API. Do not expose it publicly or treat loopback binding as authorization. Browser opening must pass a validated URL as an argument to a platform opener without a shell. Keep JSON stdout free of logs, prompts, and opener output; intentional deletion prompts belong on stderr.
