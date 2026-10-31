#!/usr/bin/env bash
# Bump Karen's version everywhere it is recorded, commit, and tag the release.
# Usage: scripts/bump-version.sh <X.Y.Z|patch|minor|major> [--push] [--no-commit]
#   X.Y.Z       exact version (a leading "v" is fine, e.g. v1.0.1; pre-releases like 1.1.0-beta.1 work too)
#   patch|minor|major  increment the current version
#   --push      push the commit and the tag to origin (this triggers the Release workflow)
#   --no-commit only edit the files; no commit, no tag
#
# Files updated: package.json, package-lock.json, src-tauri/tauri.conf.json,
#                src-tauri/Cargo.toml, src-tauri/Cargo.lock
set -euo pipefail
cd "$(dirname "$0")/.."

usage() { sed -n '3,7p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1; }

target="" push=false commit=true
for a in "$@"; do
  case "$a" in
    --push) push=true ;;
    --no-commit) commit=false ;;
    -h|--help) usage ;;
    -*) echo "unknown option: $a" >&2; usage ;;
    *) [[ -z "$target" ]] || { echo "only one version may be given" >&2; usage; }; target="$a" ;;
  esac
done
[[ -n "$target" ]] || usage
$commit || ! $push || { echo "error: --push needs a commit; drop --no-commit" >&2; exit 1; }

current="$(node -p "require('./src-tauri/tauri.conf.json').version")"
semver='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'

case "$target" in
  patch|minor|major)
    [[ "$current" =~ $semver ]] || { echo "error: current version '$current' is not semver" >&2; exit 1; }
    ma="${BASH_REMATCH[1]}" mi="${BASH_REMATCH[2]}" pa="${BASH_REMATCH[3]}" pre="${BASH_REMATCH[4]}"
    case "$target" in
      major) version="$((ma + 1)).0.0" ;;
      minor) version="$ma.$((mi + 1)).0" ;;
      # 1.1.0-beta.1 -> patch -> 1.1.0 (finish the pre-release), otherwise increment
      patch) if [[ -n "$pre" ]]; then version="$ma.$mi.$pa"; else version="$ma.$mi.$((pa + 1))"; fi ;;
    esac ;;
  *) version="${target#v}" ;;
esac

[[ "$version" =~ $semver ]] || { echo "error: '$version' is not a valid version (expected X.Y.Z)" >&2; exit 1; }
[[ "$version" != "$current" ]] || { echo "error: version is already $current" >&2; exit 1; }
tag="v$version"

if $commit; then
  [[ -z "$(git status --porcelain)" ]] || { echo "error: working tree is not clean; commit or stash first" >&2; exit 1; }
  if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    echo "error: tag $tag already exists" >&2; exit 1
  fi
  branch="$(git rev-parse --abbrev-ref HEAD)"
  [[ "$branch" == "main" ]] || echo "warning: releasing from branch '$branch', not main" >&2
fi

echo "Bumping $current -> $version"

VERSION="$version" node <<'JS'
const fs = require('fs');
const v = process.env.VERSION;

// Replace exactly one match in a file, failing loudly if the pattern is missing.
function edit(file, re, replace) {
  const src = fs.readFileSync(file, 'utf8');
  if (!re.test(src)) throw new Error(`version field not found in ${file}`);
  fs.writeFileSync(file, src.replace(re, replace));
  console.log(`  updated ${file}`);
}

// Top-level "version" (two-space indent) in package.json and tauri.conf.json.
const topLevel = /^(  "version":\s*")[^"]*(")/m;
edit('package.json', topLevel, `$1${v}$2`);
edit('src-tauri/tauri.conf.json', topLevel, `$1${v}$2`);

// package-lock.json records the version at the root and under packages[""].
edit('package-lock.json', topLevel, `$1${v}$2`);
edit('package-lock.json', /("packages":\s*\{\s*"":\s*\{[^}]*?"version":\s*")[^"]*(")/, `$1${v}$2`);

// Cargo.toml [package] version, and the karen entry in Cargo.lock.
edit('src-tauri/Cargo.toml', /(\[package\][^\[]*?\nversion\s*=\s*")[^"]*(")/, `$1${v}$2`);
edit('src-tauri/Cargo.lock', /(\[\[package\]\]\nname = "karen"\nversion = ")[^"]*(")/, `$1${v}$2`);

// Verify every file now reports the new version.
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const found = {
  'package.json': JSON.parse(fs.readFileSync('package.json', 'utf8')).version,
  'package-lock.json': lock.version,
  'package-lock.json packages[""]': lock.packages[''].version,
  'tauri.conf.json': JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8')).version,
  'Cargo.toml': fs.readFileSync('src-tauri/Cargo.toml', 'utf8').match(/\[package\][^\[]*?\nversion\s*=\s*"([^"]*)"/)[1],
  'Cargo.lock': fs.readFileSync('src-tauri/Cargo.lock', 'utf8').match(/\[\[package\]\]\nname = "karen"\nversion = "([^"]*)"/)[1],
};
const bad = Object.entries(found).filter(([, got]) => got !== v);
if (bad.length) {
  for (const [f, got] of bad) console.error(`  mismatch: ${f} has ${got}`);
  process.exit(1);
}
JS

files=(package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock)

if ! $commit; then
  echo "Done. Files updated, nothing committed."
  exit 0
fi

git add "${files[@]}"
git commit -q -m "chore(release): bump version to $version"
git tag -a "$tag" -m "Karen $tag"
echo "Committed and tagged $tag"

if $push; then
  git push origin HEAD
  git push origin "$tag"
  echo "Pushed $tag; the Release workflow will build and publish it."
else
  echo "Review with 'git show', then publish with:"
  echo "  git push origin HEAD && git push origin $tag"
fi
