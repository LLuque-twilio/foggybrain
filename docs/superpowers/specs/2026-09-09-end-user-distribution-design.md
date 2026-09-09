# End-User Distribution Design

## Goal

Two distinct audiences for this repo, served by two distinct paths:

- **Developers**: clone the repo, `pnpm install && pnpm build && pnpm link --global && pnpm start`,
  make changes, submit PRs. Fully unaffected by this design.
- **End users** (currently: the repo owner, across multiple personal machines): run a single
  command —

  ```sh
  curl -fsSL https://raw.githubusercontent.com/LLuque-twilio/foggybrain/master/scripts/install.sh | bash
  ```

  — and get a working `foggy` CLI with no local clone, no `pnpm`/build toolchain, and no manual
  `PATH` surgery. `foggy start` / `foggy stop` / `foggy dashboard` then manage the server and web UI.

## Prior art in this repo

Two earlier attempts at end-user distribution were made and reverted in this repo's history:

- `a085f93` "Add standalone CLI installation, managed servers, and guided setup" — reverted in `18136a3`
- `7dbc105` "Add Homebrew release packaging and installed CLI checks" — reverted in `074153a`

The Homebrew attempt was rejected on the grounds that piggybacking on a Homebrew-managed
directory/formula for a tool with no other reason to depend on Homebrew is the wrong layering —
hacky, and it silently assumes every target machine has (and wants) Homebrew. This design avoids
Homebrew and any other package manager entirely; distribution is via a plain GitHub Release
artifact and a POSIX shell installer, matching the pattern of tools like `rustup`, `nvm`, and `uv`.

## Non-goals (this iteration)

- Windows support for `scripts/install.sh` (a POSIX shell script). The existing dev workflow and
  the `foggy dashboard` browser-open logic already handle `win32`, so nothing regresses; the
  curl-installer path itself targets macOS and Linux only.
- Auto-installing Node.js. Node 22+ is treated as the one real prerequisite; the installer checks
  for it and fails with a clear message and a link if it's missing, rather than trying to manage
  a Node install itself.
- Multi-user/team-wide distribution, package-manager publishing (npm registry, Homebrew), or
  install-time telemetry. Out of scope until there's more than one real user.

## Architecture

### 1. Release pipeline (`.github/workflows/release.yml`, new)

Triggered on push of a `v*` tag (e.g. `v0.2.0`). Steps:

1. Checkout, `pnpm install --frozen-lockfile`, `pnpm build` (same as CI).
2. Prune dev dependencies: `pnpm install --prod` (or an equivalent isolated prune step) so the
   packaged `node_modules` contains only runtime dependencies.
3. Package `dist/`, `bin/`, the pruned `node_modules/`, and `package.json` into a single
   `foggybrain-<version>.tar.gz`.
4. Publish via `gh release create "$TAG" foggybrain-<version>.tar.gz --generate-notes`.

One artifact — no per-OS/arch matrix — since this ships plain Node source, not a compiled binary.
The repo is public, so the release asset is fetchable with a plain unauthenticated `curl`.

The existing `ci.yml` (build/test/typecheck on PR and push to `master`) is unchanged and continues
to gate merges; `release.yml` only runs on tag push.

### 2. Install script (`scripts/install.sh`, new)

Fetched and executed via the curl one-liner above. Responsibilities:

1. Verify `node -v` reports >= 22.13.0; if not, print install guidance (link to nodejs.org) and
   exit non-zero. This is the only external prerequisite the script assumes.
2. Resolve the target version: `$FOGGY_VERSION` env var if set, otherwise the latest GitHub
   Release tag (`gh release list` if `gh` is present, else a plain `curl` to the GitHub Releases
   API — no auth needed since the repo is public).
3. Download and extract `foggybrain-<version>.tar.gz` into `~/.foggybrain/versions/<version>/`.
4. Flip `~/.foggybrain/current` (a symlink) to point at that versioned directory.
5. Symlink `~/.local/bin/foggy` → `~/.foggybrain/current/bin/foggy.mjs`.
6. Ensure `~/.local/bin` is on `PATH` for every shell type, including the non-interactive shells
   agents spawn (this was the original motivating problem — a `pnpm global` install is only ever
   on `PATH` if a shell rc file happens to export it, which non-interactive/non-login shells
   often skip). Do this by writing `/etc/paths.d/foggy` containing `~/.local/bin` (prompting once
   for `sudo`, since it's a system-level config file) rather than editing any shell rc file
   directly. `/etc/paths.d/` is a native macOS mechanism read by every shell unconditionally; on
   Linux, fall back to appending a `PATH` export to `~/.profile` (read by all POSIX-compatible
   login shells) since there's no Linux equivalent of `/etc/paths.d/`.
7. Print the installed version and a `foggy start` / `foggy dashboard` hint.

Re-running the same curl command is safe and idempotent — it's exactly what `foggy upgrade` (below)
does internally.

### 3. `foggy upgrade` command

A new CLI subcommand that performs steps 2–5 of the install script in-process (shared logic
between the initial installer and `upgrade`, not a re-exec of `install.sh`): fetch latest release
(or `--version <x>` if given), extract into a new versioned directory, flip the `current` symlink.

Old versioned directories are **not** automatically deleted. This gives cheap rollback (manually
re-point `~/.foggybrain/current` to a prior version's directory) if a release regresses. Pruning
old versions can be a manual `rm -rf ~/.foggybrain/versions/<old>` or a future `foggy upgrade
--prune` flag — not needed for this iteration.

### 4. New CLI commands: `start` / `stop` / `dashboard`

Today `src/cli.ts` has a `ui` command that only opens a browser tab — it never starts the server,
and the README requires a developer to separately run `pnpm start` and leave it running. End users
installed via the tarball have no `pnpm` and no reason to run anything but `foggy`.

- **`foggy start`**: spawns `node <install-dir>/dist/server/server.js` detached
  (`stdio: 'ignore'`, `child.unref()`), and writes its PID to a pidfile under the existing data
  directory (`~/.local/share/foggybrain/foggy.pid`). If a pidfile already exists and that PID is
  alive, fail with a clear "already running" error instead of spawning a second server.
- **`foggy stop`**: reads the pidfile, sends `SIGTERM`, waits briefly for exit, then removes the
  pidfile. If no pidfile exists (or the recorded PID is dead), report that cleanly rather than
  erroring.
- **`foggy dashboard`**: the existing `ui` command's browser-open logic, renamed. `ui` is dropped
  outright rather than kept as a hidden alias — this is a pre-1.0 personal tool with no external
  consumers of the old name yet, so there's no back-compat burden.

These three commands only touch process lifecycle and are independent of the install mechanism —
they work identically for a `pnpm link --global` dev install and a curl-installed one, since both
resolve to the same `dist/server/server.js` relative to the CLI's own install location.

## Data and config, unaffected

`~/.local/share/foggybrain` (SQLite data, `.env.local`-equivalent config) is untouched by this
design — both install paths read/write the same location, so switching between a dev-linked
`foggy` and a curl-installed `foggy` on the same machine sees the same workspaces and tasks.

## Testing plan

- `scripts/install.sh` gets a shell-level smoke test (can reuse the `test-package.mjs`-style
  harness from the reverted Homebrew attempt as a reference for spawning a clean shell/PATH and
  asserting the resulting `foggy --version` and `foggy start`/`stop` work) run manually or in CI
  against a real tagged release in a scratch container/VM — not part of the fast `ci.yml` suite,
  since it needs a real published release to fetch.
- `foggy start` / `stop` / `dashboard` / `upgrade` get unit tests alongside the existing
  `cli.test.ts` patterns (mocking `spawn`, filesystem, and the GitHub Releases fetch respectively).
- Manual end-to-end check: on a machine with no prior `foggy` install (this has already been done
  once for the repo owner's primary machine as part of this design's approval), run the curl
  one-liner against a real tagged pre-release and confirm `foggy start`, `foggy dashboard`, and
  `foggy upgrade` all work with zero manual setup.

## Open items for the implementation plan

- Exact GitHub Actions permissions/token needed for `gh release create` (`contents: write` on the
  release job, scoped separately from the read-only `ci.yml` permissions).
- Whether `~/.foggybrain/versions/<version>/node_modules` pruning should use `pnpm install --prod`
  in a clean checkout vs. `pnpm prune --prod` on the already-built tree — pick whichever produces
  a smaller/more reliable artifact; verify empirically during implementation.
