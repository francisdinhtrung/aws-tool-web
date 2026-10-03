#!/usr/bin/env bash
# Build a portable Windows (x64) zip: bundled Node.js + server + web build + launcher. No install needed.
# Usage: ./scripts/build-windows-portable.sh [version]
# Env: NODE_VERSION (default: latest v22.x), OUT_DIR (default: ./release)
# Runs on macOS, Linux or Git Bash; needs curl, unzip, zip and Node.js/npm.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-$(node -p "require('$ROOT/server/package.json').version")}"
OUT_DIR="${OUT_DIR:-$ROOT/release}"
NAME="aws-tool-web-$VERSION-win-x64"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ -z "${NODE_VERSION:-}" ]; then
  NODE_VERSION=$(curl -fsSL https://nodejs.org/dist/index.json |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).find(r=>r.version.startsWith("v22.")).version))')
fi
NODE_ZIP="node-$NODE_VERSION-win-x64.zip"
CACHE="$OUT_DIR/.cache"
mkdir -p "$CACHE"

echo "==> Node.js $NODE_VERSION (win-x64)"
if [ ! -f "$CACHE/$NODE_ZIP" ]; then
  curl -fL --progress-bar -o "$CACHE/$NODE_ZIP.part" "https://nodejs.org/dist/$NODE_VERSION/$NODE_ZIP"
  mv "$CACHE/$NODE_ZIP.part" "$CACHE/$NODE_ZIP"
fi
EXPECTED=$(curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" | awk -v f="$NODE_ZIP" '$2 == f { print $1 }')
if command -v sha256sum >/dev/null; then ACTUAL=$(sha256sum "$CACHE/$NODE_ZIP" | awk '{print $1}')
else ACTUAL=$(shasum -a 256 "$CACHE/$NODE_ZIP" | awk '{print $1}'); fi
if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "Checksum mismatch for $NODE_ZIP (expected '$EXPECTED', got '$ACTUAL')" >&2
  rm -f "$CACHE/$NODE_ZIP"
  exit 1
fi

STAGE="$WORK/$NAME"
mkdir -p "$STAGE/runtime" "$STAGE/app/server" "$STAGE/app/web" "$STAGE/data"
unzip -q -j "$CACHE/$NODE_ZIP" "node-$NODE_VERSION-win-x64/node.exe" "node-$NODE_VERSION-win-x64/LICENSE" -d "$WORK/node"
mv "$WORK/node/node.exe" "$STAGE/runtime/"
mv "$WORK/node/LICENSE" "$STAGE/runtime/NODE-LICENSE.txt"

echo "==> Building web"
(cd "$ROOT/web" && npm ci --no-audit --no-fund && npm run build)
cp -R "$ROOT/web/dist" "$STAGE/app/web/dist"

echo "==> Installing server production dependencies"
cp "$ROOT/server/package.json" "$ROOT/server/package-lock.json" "$STAGE/app/server/"
cp -R "$ROOT/server/src" "$STAGE/app/server/src"
# Pure-JavaScript dependencies only, so installing on any OS gives a tree that runs on Windows.
(cd "$STAGE/app/server" && npm ci --omit=dev --no-audit --no-fund --ignore-scripts)
rm "$STAGE/app/server/package-lock.json"

echo "==> Launcher and docs"
# Windows tools expect CRLF line endings.
sed 's/$/\r/' "$ROOT/packaging/windows/AWS Tool Web.cmd" >"$STAGE/AWS Tool Web.cmd"
sed 's/$/\r/' "$ROOT/packaging/windows/README.txt" >"$STAGE/README.txt"
sed 's/$/\r/' "$ROOT/LICENSE" >"$STAGE/LICENSE.txt"

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR/$NAME.zip"
(cd "$WORK" && zip -qr -9 "$OUT_DIR/$NAME.zip" "$NAME")
echo "==> $OUT_DIR/$NAME.zip ($(du -h "$OUT_DIR/$NAME.zip" | cut -f1))"
