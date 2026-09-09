#!/bin/sh
# Manual/CI smoke test: installs a published FoggyBrain release into a throwaway HOME and exercises
# the installed CLI. Requires a real published release. Usage: scripts/install-smoke.sh 0.2.0
set -eu

VERSION="${1:-}"
[ -n "$VERSION" ] || { printf 'usage: %s <version>\n' "$0" >&2; exit 2; }

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT HUP INT TERM

HOME="$SANDBOX/home"
mkdir -p "$HOME"
export HOME
export FOGGY_HOME="$HOME/.foggybrain"
export FOGGY_VERSION="$VERSION"
export FOGGY_DATA_DIR="$SANDBOX/data"
export FOGGY_PORT=4377

sh "$ROOT/scripts/install.sh"

FOGGY="$HOME/.local/bin/foggy"
[ -x "$FOGGY" ] || { printf 'smoke: %s is not executable\n' "$FOGGY" >&2; exit 1; }

# A clean PATH (repo tree and package managers excluded, node kept since foggy execs via
# `#!/usr/bin/env node`) proves the installed CLI needs nothing from the developer environment.
node_dir=$(dirname "$(command -v node)")
installed=$(env -i HOME="$HOME" PATH="$HOME/.local/bin:$node_dir:/usr/bin:/bin" foggy --version)
[ "$installed" = "$VERSION" ] || { printf 'smoke: expected %s, got %s\n' "$VERSION" "$installed" >&2; exit 1; }

"$FOGGY" --json start >/dev/null
attempt=0
until curl -fsS "http://127.0.0.1:$FOGGY_PORT/api/state" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 100 ] || { "$FOGGY" --json stop >/dev/null 2>&1 || true; printf 'smoke: server never answered\n' >&2; exit 1; }
  sleep 0.1
done
"$FOGGY" --json stop >/dev/null

printf 'smoke: FoggyBrain %s installs, starts, and stops cleanly\n' "$VERSION"
