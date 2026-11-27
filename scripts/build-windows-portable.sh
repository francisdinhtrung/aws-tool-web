#!/usr/bin/env bash
# Build a portable Windows (x64) ZIP or a single self-extracting EXE.
# Usage: ./scripts/build-windows-portable.sh [--exe] [version]
# Env: NODE_VERSION (latest v22.x), OUT_DIR (./release), GO_BIN (go for --exe)
# Runs on macOS, Linux or Git Bash. The EXE build also needs Go 1.23 or later.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORMAT=zip
GO_BIN="${GO_BIN:-go}"
if [ "${1:-}" = '--exe' ]; then
  FORMAT=exe
  shift
  if ! command -v "$GO_BIN" >/dev/null; then
    echo 'The --exe build needs Go 1.23 or later. Set GO_BIN to the Go executable.' >&2
    exit 1
  fi
fi
VERSION="${1:-$(node -p 'require(process.argv[1]).version' "$ROOT/server/package.json")}"
OUT_DIR="${OUT_DIR:-$ROOT/release}"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
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

sed 's/$/\r/' "$ROOT/LICENSE" >"$STAGE/LICENSE.txt"

if [ "$FORMAT" = exe ]; then
  echo '==> Building the single-file Windows launcher'
  mkdir -p "$WORK/launcher"
  cp "$ROOT/packaging/windows/exe/"*.go "$WORK/launcher/"
  cp "$("$GO_BIN" env GOROOT)/LICENSE" "$STAGE/runtime/GO-LICENSE.txt"
  (cd "$STAGE" && zip -qr -9 "$WORK/launcher/payload.zip" app runtime LICENSE.txt)
  (cd "$WORK/launcher" && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 "$GO_BIN" build -trimpath -ldflags='-s -w' -o "$WORK/$NAME.exe" launcher.go browser_windows.go)
  mv "$WORK/$NAME.exe" "$OUT_DIR/$NAME.exe"
else
  echo '==> Launcher and docs'
  sed 's/$/\r/' "$ROOT/packaging/windows/AWS Tool Web.cmd" >"$STAGE/AWS Tool Web.cmd"
  sed 's/$/\r/' "$ROOT/packaging/windows/README.txt" >"$STAGE/README.txt"
  (cd "$WORK" && zip -qr -9 "$WORK/$NAME.zip" "$NAME")
  mv "$WORK/$NAME.zip" "$OUT_DIR/$NAME.zip"
fi
echo "==> $OUT_DIR/$NAME.$FORMAT ($(du -h "$OUT_DIR/$NAME.$FORMAT" | cut -f1))"
