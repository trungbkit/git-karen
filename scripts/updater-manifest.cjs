// Builds the updater manifest (latest.json) of a release from its uploaded installers and their .sig files.
// Used by the publish step of .github/workflows/release.yml; the app reads it from
// https://github.com/<owner>/<repo>/releases/latest/download/latest.json (tauri.conf.json > plugins > updater).
//
// The updater looks for `{os}-{arch}-{installer}` first, then `{os}-{arch}`, so every installer the app can be
// running from gets its own entry, and the plain keys point at the installer used when the type is unknown.

/** Installer asset name patterns, by updater target. `fallback` also publishes it under the plain `{os}-{arch}` key. */
const TARGETS = [
  { key: 'darwin-aarch64-app', pattern: /_aarch64\.app\.tar\.gz$/, fallback: 'darwin-aarch64' },
  { key: 'darwin-x86_64-app', pattern: /_(x64|x86_64)\.app\.tar\.gz$/, fallback: 'darwin-x86_64' },
  { key: 'linux-x86_64-appimage', pattern: /_amd64\.AppImage$/, fallback: 'linux-x86_64' },
  { key: 'linux-x86_64-deb', pattern: /_amd64\.deb$/ },
  { key: 'linux-x86_64-rpm', pattern: /\.x86_64\.rpm$/ },
  { key: 'windows-x86_64-nsis', pattern: /_x64-setup\.exe$/, fallback: 'windows-x86_64' },
  { key: 'windows-x86_64-msi', pattern: /_x64(_[A-Za-z-]+)?\.msi$/ }
]

/**
 * @param {object} release
 * @param {string} release.version       e.g. "1.0.3" (no leading v)
 * @param {string} release.notes
 * @param {string} release.pubDate       RFC 3339
 * @param {string[]} release.assets      names of the release's assets
 * @param {Record<string, string>} release.signatures  contents of each `<asset>.sig`, by installer asset name
 * @param {(name: string) => string} release.url       download URL of an asset
 * @returns the manifest; throws when an installer or its signature is missing
 */
function buildManifest({ version, notes, pubDate, assets, signatures, url }) {
  const platforms = {}
  const problems = []
  for (const target of TARGETS) {
    const matches = assets.filter((a) => target.pattern.test(a))
    if (matches.length !== 1) {
      problems.push(`${target.key}: expected one installer matching ${target.pattern}, found ${matches.length ? matches.join(', ') : 'none'}`)
      continue
    }
    const [name] = matches
    const signature = signatures[name]?.trim()
    if (!signature) {
      problems.push(`${target.key}: ${name} has no ${name}.sig`)
      continue
    }
    const entry = { signature, url: url(name) }
    platforms[target.key] = entry
    if (target.fallback) platforms[target.fallback] = entry
  }
  if (problems.length) throw new Error(`Cannot build latest.json:\n  ${problems.join('\n  ')}`)
  return { version, notes, pub_date: pubDate, platforms }
}

/** Release notes for the update prompt: the release body without the first-install instructions. */
function releaseNotes(body) {
  return (body || '')
    .replace(/^## Installing on macOS\n[\s\S]*?(?=^## |(?![\s\S]))/m, '')
    .trim()
}

module.exports = { TARGETS, buildManifest, releaseNotes }
