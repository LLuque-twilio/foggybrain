# Contributing

For end-user Homebrew installation, see the [README](README.md#install).
The instructions here are for contributors and maintainers.

## Development Setup

Use Node.js 22 (at least 22.13.0) and pnpm 10.14.0, pinned in `package.json`.
With a Corepack-enabled Node installation, run `corepack enable` if needed.
Clone the repository and run these commands from its root:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Maintain `pnpm-lock.yaml`, not another lockfile. Dependency build scripts are
allowlisted for `esbuild` only. Optional `pnpm link` after building provides a
checkout-linked executable, not a standalone end-user installation.

Read [AGENTS.md](AGENTS.md) for development and safety rules. Before changing API
consumers or domain behavior, read [openapi.json](openapi.json),
[CONTRACT.md](CONTRACT.md), and `src/shared.ts`.
The server owns persistence, validation, IDs, and completion.

### Running Locally

Use an explicit absolute temporary `FOGGY_DATA_DIR` and isolated configuration
for manual experiments, never your working graph. Isolate HOME too when testing
managed startup, setup, or stop: stop is user-wide, even across data directories.
Never drive `foggy setup` through agent tools on the user's real HOME; test it only
with isolated HOME and simulated terminals. Do not run two servers against one
data directory. Stop a known conflicting server first; never kill an unknown listener.

`pnpm dev` starts the foreground API at `http://127.0.0.1:4173` and Vite UI at
`http://127.0.0.1:5173`. Its Vite proxy targets `4173` and does not follow a changed
`FOGGY_PORT` automatically. Stop the full stack with Ctrl-C in its terminal;
`foggy stop` does not stop Vite or watchers, which can restart the API.

To run the built API and UI together at `http://127.0.0.1:4173`:

```sh
pnpm build
pnpm start
```

`pnpm start` does not rebuild. Foreground `pnpm start` and `pnpm dev` load
working-directory `.env.local`, then `.env`, below process environment precedence.
Use ignored dotenv files, never commit credentials. Managed startup instead loads
`~/.config/foggybrain/.env` and ignores checkout dotenv files. Managed relative data
paths resolve against `~/.config/foggybrain`; foreground relative paths resolve
against the working directory. Prefer absolute paths and restart after changes.

### Source CLI

The CLI itself executes TypeScript, but **run `pnpm build` once before using
managed auto-start or the built dashboard from source**, and rebuild after server
or UI changes. Managed startup launches the compiled server, not the source watcher.
With isolated data/configuration selected, default commands can start/reuse it:

```sh
pnpm --silent run foggy --json task list
pnpm --silent run foggy dashboard
```

For an already running development server, use an explicit URL to bypass managed
startup. No CLI build is needed for this source execution route:

```sh
pnpm --silent run foggy --url http://127.0.0.1:4173 --json task list
pnpm --silent run foggy --url http://127.0.0.1:5173 ui
```

CLI flags follow `foggy` directly, without an extra `--` separator. Use
`pnpm --silent run foggy` for machine-consumed JSON to suppress pnpm's banner.
Explicit `--url` or process `FOGGY_URL` always bypasses auto-start, even on loopback.
`ui` only opens a browser; it never starts or probes the server.

## Checks

Submit focused pull requests and run all three checks after changes:

```sh
pnpm test
pnpm typecheck
pnpm build
```

For API changes, run `pnpm openapi:generate`, review the generated `openapi.json`,
and run `pnpm openapi:check` as well. Never hand edit the spec. Shared DTOs own
field shapes; `scripts/openapi.ts` owns route metadata and focused conditional
schema refinements. Runtime validation still owns graph/state rules. See the
[API maintainer guide](docs/api.md) for ownership and contract-test coverage.

The spec check verifies artifact freshness and parser validity. `pnpm test` also
checks route inventory, HTTP success responses for all 45 operations, and request
boundaries. CLI tests spawn real Commander invocations against a fake HTTP server,
without a live application server or GitHub token. Run just those tests with:

```sh
node --import tsx --test src/cli.test.ts
```

For UI changes, run:

```sh
pnpm exec playwright install chromium # Once
pnpm test:e2e
```

Browser tests cover desktop and mobile Chromium. The suite builds the app, starts
an isolated server on port `4189` with temporary storage and blank GitHub
credentials, and removes temporary data at shutdown. Unit/integration tests mock
GitHub; they do not verify real repository access. Format changed files with
Prettier. Report failed checks and checks you could not run.

Use synthetic fixtures and isolated temporary storage. Never run tests against
your working database or perform real GitHub writes in tests. Do not commit
credentials, state exports, or personal task data, including screenshots and logs.
Ignored files can still be force-added; review your staged diff.

## Maintainer Releases

No release has been published yet. `.github/workflows/release.yml` runs on version
tags and creates a draft only after checks pass. Publishing remains a maintainer
decision; do not move published tags or overwrite release assets.
The public [Homebrew tap](https://github.com/LLuque-twilio/homebrew-tap) is set up.
No formula goes live until a real first release is published; installation
also requires merging its formula into the tap.

1. Bump `version` in `package.json` to the selected `X.Y.Z`. Keep `private: true`;
   distribution is a prebuilt GitHub release archive, never `npm publish`.
2. Run `pnpm install --lockfile-only` if the version or dependency changes require
   lockfile updates, and review the diff. Do not introduce an npm lockfile.
3. Run `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm openapi:check`, and
   `pnpm test:e2e` (install Chromium first if needed). Run `pnpm test:package`,
   which packs and tests the actual archive, not merely checkout files. It needs
   npm registry access to install runtime dependencies into a temporary prefix.
   Run `node --test scripts/homebrew.test.mjs` for formula generation tests.
4. Review and commit the release changes through the normal review process.
   Only a maintainer creates and pushes the `vX.Y.Z` git tag, matching the exact
   `package.json` version, on the reviewed commit. Do not tag a dirty checkout.
5. The release workflow checks tests, types, spec freshness, and e2e, and
   validates the exact release archive on Linux and macOS. It creates a **DRAFT** GitHub release
   containing `foggybrain-X.Y.Z.tgz`, `SHA256SUMS`, and (for stable versions) `foggybrain.rb`, without
   publishing automatically. `scripts/homebrew.mjs` generates the formula from
   the release archive's SHA-256.
6. Review the draft's version/tag, checks, release notes, archive contents, and
   checksums. A maintainer then publishes it manually at
   [GitHub Releases](https://github.com/LLuque-twilio/foggybrain/releases).
7. After publishing, open a PR in the public tap adding or updating
   `Formula/foggybrain.rb` with the generated asset. This is a manual maintainer
   handoff, with no cross-repository bot token. Compare the formula URL, checksum,
   and version against the published release. Require passing release checks and
   tap CI before merging; tap CI will `brew install` and `brew test` the formula
   on macOS and Linux.

The formula consumes the prebuilt tgz, manages `node@22`, and uses npm internally
to fetch runtime dependencies. The archive checksum verifies the artifact, not a
lock of transitive dependencies. No Homebrew service is provided: `foggy` owns
the managed lifecycle. Do not add sudo or a `curl | sh` installer.

For local packaging, `pnpm pack` runs `pnpm build` via `prepack`. The archive
contains bin, dist, README, LICENSE, CONTRACT, openapi, and docs, excluding compiled
test JS. Inspect the actual tarball contents when changing packaging. Package
tests must install and exercise the archive in isolated temporary HOME, npm prefix,
configuration, and data storage, without real GitHub writes. Never globally install
on the user's machine without authorization. End users install through Homebrew;
they do not run this maintainer build process or invoke npm directly.

Run `pnpm test:package /absolute/path/to/foggybrain-X.Y.Z.tgz` to verify an
existing archive without rebuilding it. The smoke test checks package contents,
production installation, CLI auto-start, served UI assets, persistence across
restart, and graceful shutdown. It never runs setup or opens a browser.
Release builds use fresh CI checkouts; use a fresh checkout for local release
packaging too, since compilation does not remove obsolete files from `dist/`.

## Review And Conduct

Outside-contributor CI may require maintainer approval. Approval to run CI is not
approval to merge. Dependency and workflow updates require review like any other
code. Do not use privileged workflows to execute pull-request code.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
Keep discussions respectful and focused on the work.

Contributions are licensed under the repository's [MIT license](LICENSE).
