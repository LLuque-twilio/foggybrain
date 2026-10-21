# FoggyBrain

A Claude Code usage skill for FoggyBrain's CLI and task-context API. It manages
persistent task graphs, shared tasks, Markdown context, PR merge gates, external
resources, tags, local/cloud workspaces, safe cloud retargeting, and reviewed state
sync. It does not install FoggyBrain, start a server, or provide an MCP server.

## Install

```text
/plugin marketplace add LLuque-twilio/foggybrain
/plugin marketplace update foggybrain
/plugin install foggybrain@foggybrain
```

Invoke `/foggybrain:foggybrain`, or ask Claude to manage work in FoggyBrain.

## Prerequisites

- A running FoggyBrain server, normally at `http://127.0.0.1:4173`. Start it with
  `foggy start`.
- An installed `foggy` executable. Requires Node.js 22 (22.13.0+); no clone or pnpm
  needed:

  ```sh
  curl -fsSL https://raw.githubusercontent.com/LLuque-twilio/foggybrain/master/scripts/install.sh | bash
  ```

  `foggy upgrade` updates it later. Alternatively, run from a local FoggyBrain
  checkout with dependencies installed, using `pnpm --silent run foggy` from that
  checkout. `pnpm dev` runs the development servers; `pnpm build` followed by
  `pnpm start` serves the built app. Do not start a second server against the same
  data directory.

- Set process/config `FOGGY_URL` or supply `--url` for a different server. The CLI
  reads `~/.foggybrain/config.json`, with process environment taking precedence, but
  does not load the server working directory's `.env`.

## Examples

- "Show available FoggyBrain work in my personal workspace."
- "Create a release container with frontend and backend work, both blocking deploy."
- "Reference the existing security review in this release without copying it."
- "Attach the design brief and Jira ticket to this task."
- "Read this task's Markdown context before working on it."
- "Record progress and the PR link in this task's context as you work."
- "Update this task's context without overwriting the existing notes."
- "Create an Urgent tag and apply it to the release tasks."
- "Make my Personal workspace the default."
- "Retarget this cloud workspace while preserving its branch, path, and credential."
- "Explain all graph and context sync conflicts before resolving anything."
- "Preview syncing this workspace and explain both sides before applying."
- "Preview deleting this container and show me the external impact."

The skill requires reviewed authorization before cascading deletion or sync apply.
It does not grant unrestricted Bash permissions. The only hook is a read-only
`UserPromptSubmit` nudge that offers to create a task and never creates one itself.
Tokens remain on the server. Cloud workspaces are local-first, with explicit manual sync.

## Local Validation

From the FoggyBrain repository root:

```sh
claude plugin validate .
claude plugin validate ./plugins/foggybrain
claude --plugin-dir ./plugins/foggybrain
```

In that session, invoke `/foggybrain:foggybrain` and ask for a read-only workspace
list. Exercise mutations only against an isolated server with an explicit temporary
`FOGGY_DATA_DIR`, never a personal graph or real GitHub sync target. Confirm that
deletion and sync requests stop after preview to request authorization.

The source of truth is FoggyBrain's `docs/cli.md`, `AGENTS.md`, `CONTRACT.md`,
`openapi.json`, and `src/shared.ts`. Recheck the skill when CLI semantics change.
