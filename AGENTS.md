# Working In FoggyBrain

Read `CONTRACT.md` and `src/shared.ts` before changing API consumers or domain behavior. The server owns persistent state, IDs, validation, and derived completion. Do not implement a second completion algorithm or fallback local state in the CLI or UI.

## Setup And Checks

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

For manual integration work, `pnpm dev` starts the API on `127.0.0.1:4173` and the development UI on `127.0.0.1:5173`. For the built app, `pnpm build && pnpm start` serves both API and UI on `127.0.0.1:4173`. `pnpm start` does not rebuild. Keep a server running for CLI usage. Use an explicit temporary `FOGGY_DATA_DIR` for manual experiments rather than mutating a user's real graph. The dev Vite proxy targets `4173` and does not follow a changed `FOGGY_PORT` automatically.

## Agent CLI Usage

Use source execution with quiet pnpm output, or build and optionally `pnpm link` to use `foggy`:

```sh
pnpm --silent run foggy --json graph
pnpm --silent run foggy --json task list --status available
pnpm --silent run foggy --json task show TASK_ID
```

`FOGGY_URL` defaults to `http://127.0.0.1:4173`; global `--url` overrides it. The CLI reads its process environment, not the server `.env`. Use `--json` for every machine-consumed command. Success is one JSON value on stdout and exit `0`; failures are one `{"error":"message"}` on stderr, empty stdout, and exit `1`. `--help` remains plain text. Ordinary `pnpm foggy` adds pnpm's banner, so do not parse that stdout as JSON. Place `--silent` before `run` and CLI arguments after `foggy`, without an extra `--` separator. Never assume a successful GitHub status/sync call means GitHub succeeded: inspect `error`, `configured`, and `syncing`.

Use IDs returned by the server, never titles, list indexes, or guessed IDs. A task ID identifies a task; dependency and reference removals require their separate relationship IDs. See `docs/cli.md` for every supported flag and a branching/shared-reference workflow.

```sh
foggy --json task create "Implement the change" --kind manual --parent CONTAINER_ID
foggy --json dependency add PREREQUISITE_ID DEPENDENT_ID
foggy --json reference add CONTAINER_ID EXISTING_TASK_ID
foggy --json task done MANUAL_TASK_ID
foggy --json task show MANUAL_TASK_ID
```

`task done` satisfies only the manual own condition. `ready` means own condition satisfied but blocked from completion by prerequisites; it is not `completed`. `available` means unfinished own work without incomplete prerequisites; `blocked` means unfinished own work with incomplete prerequisites. A PR task requires a verified merge. A container requires all owned and referenced children to complete; **empty containers remain open**. Reopening propagates through dependencies and shared memberships. Containment, reference, and dependency cycles are invalid. References share identity and completion without changing ownership.

`task list --parent ID` shows immediate owned children only. `task show ID` includes referenced children and direct prerequisites/dependents. `graph ID` scopes to a container and transitive owned/referenced children; only relationships with both endpoints in scope appear, so use unscoped `graph` or `task show` to inspect external edges.

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

`GH_TOKEN` belongs in the server environment or ignored `.env`, never source, task text, command URLs, logs, or committed fixtures. Fine-grained token access should be read-only and limited to relevant repositories: Metadata and Pull requests read, Contents read if required, plus any organization/SSO approval. Do not claim universal repository access. GitHub polling runs only while the server runs; poll errors can leave stale last-verified PR state. Report stale/error conditions rather than inventing successful syncs.

The app is a trusted local tool, not an authenticated multi-user API. Do not expose it publicly or treat loopback binding as authorization. Browser opening must pass a validated URL as an argument to a platform opener without a shell. Keep JSON stdout free of logs, prompts, and opener output; intentional deletion prompts belong on stderr.
