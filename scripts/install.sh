#!/bin/sh
# Installs the FoggyBrain CLI from a GitHub release. Usage:
#   curl -fsSL https://raw.githubusercontent.com/LLuque-twilio/foggybrain/master/scripts/install.sh | bash
# Environment: FOGGY_VERSION pins a release (default: latest), FOGGY_HOME relocates ~/.foggybrain,
# FOGGY_FORCE=1 replaces a ~/.local/bin/foggy that belongs to another installation.
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
  *[!0-9A-Za-z.-]*) fail "Invalid version: $VERSION" ;;
esac
case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) fail "Invalid version: $VERSION" ;;
esac

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

ASSET="foggybrain-$VERSION.tar.gz"

printf 'Installing FoggyBrain %s...\n' "$VERSION"
curl -fsSL -o "$TMP/$ASSET" \
  "https://github.com/$REPO/releases/download/v$VERSION/$ASSET" ||
  fail "Cannot download release v$VERSION."
curl -fsSL -o "$TMP/SHA256SUMS" \
  "https://github.com/$REPO/releases/download/v$VERSION/SHA256SUMS" ||
  fail "Cannot download SHA256SUMS for release v$VERSION."

# An exact name match: a substring match would also accept a future $ASSET.asc line and then fail
# as a bogus checksum mismatch.
awk -v asset="$ASSET" '{ name = $2; sub(/^\*/, "", name); if (name == asset) { print; found = 1 } }
END { exit found ? 0 : 1 }' "$TMP/SHA256SUMS" > "$TMP/SHA256SUMS.asset" ||
  fail "SHA256SUMS has no entry for $ASSET."

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$TMP" && sha256sum -c SHA256SUMS.asset >/dev/null 2>&1) ||
    fail "Checksum mismatch for $ASSET: expected $(awk '{print $1}' "$TMP/SHA256SUMS.asset"), got $(sha256sum "$TMP/$ASSET" | awk '{print $1}')."
elif command -v shasum >/dev/null 2>&1; then
  (cd "$TMP" && shasum -a 256 -c SHA256SUMS.asset >/dev/null 2>&1) ||
    fail "Checksum mismatch for $ASSET: expected $(awk '{print $1}' "$TMP/SHA256SUMS.asset"), got $(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')."
else
  fail "Neither sha256sum nor shasum is available; cannot verify release integrity."
fi

DEST="$FOGGY_HOME/versions/$VERSION"
rm -rf "$DEST"
mkdir -p "$DEST"
tar -xzf "$TMP/$ASSET" -C "$DEST" --strip-components=1
[ -f "$DEST/bin/foggy.mjs" ] || fail "Release archive is missing bin/foggy.mjs."

FORCE=""
[ "${FOGGY_FORCE:-}" = "1" ] && FORCE="--force"
# shellcheck disable=SC2086
FOGGY_HOME="$FOGGY_HOME" node "$DEST/bin/foggy.mjs" link --version "$VERSION" $FORCE >/dev/null ||
  fail "Cannot link FoggyBrain $VERSION. If $HOME/.local/bin/foggy belongs to another installation, re-run this installer with FOGGY_FORCE=1 to replace it."

printf 'FoggyBrain %s installed to %s\n' "$VERSION" "$DEST"
printf 'Run: foggy start && foggy dashboard\n'
printf 'Open a new terminal first if foggy is not yet on your PATH.\n'
