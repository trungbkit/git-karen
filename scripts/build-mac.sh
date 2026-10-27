#!/usr/bin/env bash
# Build Karen as a native macOS app (.app, .dmg) with Tauri.
# Usage: scripts/build-mac.sh [arm64|x64|universal] [--dir]
#   arch  defaults to the host architecture
#   --dir only produces the .app bundle (faster, no dmg)
set -euo pipefail
cd "$(dirname "$0")/.."

[[ "$(uname -s)" == "Darwin" ]] || { echo "error: macOS builds must run on macOS" >&2; exit 1; }

arch="$(uname -m)"; [[ "$arch" == "x86_64" ]] && arch="x64"
bundles="app,dmg"
for a in "$@"; do
  case "$a" in
    arm64|x64|universal) arch="$a" ;;
    --dir) bundles="app" ;;
    *) echo "unknown argument: $a" >&2; exit 1 ;;
  esac
done

case "$arch" in
  arm64) target="aarch64-apple-darwin"; rust_targets=(aarch64-apple-darwin) ;;
  x64) target="x86_64-apple-darwin"; rust_targets=(x86_64-apple-darwin) ;;
  universal) target="universal-apple-darwin"; rust_targets=(aarch64-apple-darwin x86_64-apple-darwin) ;;
esac
command -v rustup >/dev/null && rustup target add "${rust_targets[@]}" >/dev/null

[[ -d node_modules ]] || npm ci

npm run typecheck
npx tauri build --target "$target" --bundles "$bundles"

echo
echo "Done. Artifacts:"
ls -1d "src-tauri/target/$target/release/bundle/macos/"*.app "src-tauri/target/$target/release/bundle/dmg/"*.dmg 2>/dev/null || true
