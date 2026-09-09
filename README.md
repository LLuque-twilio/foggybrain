# FoggyBrain

A local task graph for untangling work. Organize tasks into containers, connect prerequisites, and track GitHub merge gates. The web UI and CLI share the same running server and local data.

## Run Locally

Requires **Node.js 22 (22.13.0+)** and **pnpm 10.14.0**. From your cloned FoggyBrain repository:

```sh
pnpm install
pnpm build
pnpm link --global
pnpm start
```

Open **http://127.0.0.1:4173**. Leave the server running, or start it in the background with `foggy start`. GitHub credentials are optional for local manual tasks.

If linking reports a missing global bin directory, run `pnpm setup`, reopen your terminal, and retry `pnpm link --global`. Restart existing agents/editors to pick up the new `PATH`; their environment must include the directory from `pnpm bin -g`.

## Use From Any Repository

In another terminal, or through an AI agent:

```sh
foggy --json workspace list
foggy --json task create "Plan the release" --kind manual
foggy --json task list --status available
foggy --json task show TASK_ID
foggy --json task done TASK_ID
foggy start
foggy dashboard
```

Use IDs returned by the server. If no workspace exists, create one with `foggy --json workspace create "Personal"`. For a specific workspace, pass `--workspace ID`; your current repository does not select it.

In the UI, create a container, add tasks, and connect prerequisites. A task completes only when its own work and all prerequisites are satisfied. PR tasks require a verified merge; empty containers stay open.

### Agents And CLI

- Use `--json` for machine-readable output and `foggy --help` to discover commands.
- The server defaults to `http://127.0.0.1:4173`; override with `--url` or `FOGGY_URL`.
- Before deletion, run `foggy --json task delete TASK_ID --dry-run`, review the impact, and obtain approval before repeating with `--yes` instead of `--dry-run`.
- Preview and obtain approval before applying state sync. Never blindly retry timed-out writes.

See the [CLI reference](docs/cli.md) for all commands and [agent guidance](AGENTS.md) for automation rules.

## Develop And Update

For live server/UI development, use `pnpm dev` **instead of** `pnpm start`. Open **http://127.0.0.1:5173**; the API remains on port `4173`.

The global CLI links to this checkout's build. Keep the checkout in place and run `pnpm build` after CLI changes; no relinking is needed. Without a build, run the source from this repo with `pnpm --silent run foggy --json task list`.

To update the built app, stop the server, then run:

```sh
pnpm install
pnpm build
pnpm start
```

Run `pnpm test` and `pnpm typecheck` before committing. See [Contributing](CONTRIBUTING.md) for the full checks.

## GitHub And Data

- **PR tracking:** configure a read-only server token in ignored `.env.local`. See [GitHub setup](docs/local-guide.md#github).
- **Cloud workspaces:** optional manual sync to a private GitHub repository, not hosted state. See [sync token setup](docs/local-guide.md#create-a-dedicated-sync-token) and [workspace setup](docs/local-guide.md#workspaces).
- **Local storage:** defaults to `~/.local/share/foggybrain`; preserve it across updates. Stop the server before backing it up. See [configuration](docs/local-guide.md#configuration-and-data).
- **Local use only:** the API is not an authenticated multi-user service. Do not expose it publicly.

## Reference

[Local usage guide](docs/local-guide.md) | [CLI](docs/cli.md) | [API](openapi.json) | [Semantic contract](CONTRACT.md) | [Security](SECURITY.md) | [MIT license](LICENSE)
