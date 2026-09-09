#!/bin/sh
# Installs the FoggyBrain CLI from a GitHub release. Usage:
#   curl -fsSL https://raw.githubusercontent.com/LLuque-twilio/foggybrain/master/scripts/install.sh | bash
# Environment: FOGGY_VERSION pins a release (default: latest), FOGGY_HOME relocates ~/.foggybrain.
set -eu

REPO="LLuque-twilio/foggybrain"
FOGGY_HOME="${FOGGY_HOME:-$HOME/.foggybrain}"

fail() {
  printf 'foggybrain install: %s\n' "$1" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v tar >/dev/null 2>&1 || fail "tar is required."
command -v node >/dev/null 2>&1 ||
  fail "Node.js 22.13.0 or newer is required. Install it from https://nodejs.org and re-run this installer."

node -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number);
process.exit(major > 22 || (major === 22 && (minor > 13 || (minor === 13 && patch >= 0))) ? 0 : 1);' ||
  fail "Node.js $(node -v) is too old; FoggyBrain needs 22.13.0 or newer. See https://nodejs.org."

if [ -n "${FOGGY_VERSION:-}" ]; then
  VERSION="${FOGGY_VERSION#v}"
else
  VERSION=$(
    curl -fsSL -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/repos/$REPO/releases/latest" |
      node -e 'let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const tag = JSON.parse(input).tag_name;
  if (typeof tag !== "string") throw new Error("no tag_name");
  process.stdout.write(tag.replace(/^v/, ""));
});'
  ) || fail "Cannot resolve the latest release. Set FOGGY_VERSION to install a specific version."
fi

case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) fail "Invalid version: $VERSION" ;;
esac

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

printf 'Installing FoggyBrain %s...\n' "$VERSION"
curl -fsSL -o "$TMP/foggybrain.tar.gz" \
  "https://github.com/$REPO/releases/download/v$VERSION/foggybrain-$VERSION.tar.gz" ||
  fail "Cannot download release v$VERSION."

DEST="$FOGGY_HOME/versions/$VERSION"
rm -rf "$DEST"
mkdir -p "$DEST"
tar -xzf "$TMP/foggybrain.tar.gz" -C "$DEST" --strip-components=1
[ -f "$DEST/dist/server/cli.js" ] || fail "Release archive is missing dist/server/cli.js."

FOGGY_HOME="$FOGGY_HOME" node "$DEST/dist/server/cli.js" link --version "$VERSION" >/dev/null ||
  fail "Cannot link FoggyBrain $VERSION."

printf 'FoggyBrain %s installed to %s\n' "$VERSION" "$DEST"
printf 'Run: foggy start && foggy dashboard\n'
printf 'Open a new terminal first if foggy is not yet on your PATH.\n'
