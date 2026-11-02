import { describe, expect, it } from 'vitest'
import { buildManifest, releaseNotes } from './updater-manifest.cjs'

const ASSETS = [
  'Karen_aarch64.app.tar.gz',
  'Karen_x64.app.tar.gz',
  'Karen_1.0.3_aarch64.dmg',
  'Karen_1.0.3_x64.dmg',
  'Karen_1.0.3_amd64.AppImage',
  'Karen_1.0.3_amd64.deb',
  'Karen-1.0.3-1.x86_64.rpm',
  'Karen_1.0.3_x64-setup.exe',
  'Karen_1.0.3_x64_en-US.msi'
]
const signed = (names: string[]) => Object.fromEntries(names.filter((n) => !n.endsWith('.dmg')).map((n) => [n, `sig of ${n}\n`]))
const release = (assets = ASSETS, signatures = signed(ASSETS)) => ({
  version: '1.0.3',
  notes: 'notes',
  pubDate: '2026-11-02T00:00:00Z',
  assets: [...assets, ...Object.keys(signatures).map((n) => `${n}.sig`)],
  signatures,
  url: (name: string) => `https://example.com/v1.0.3/${name}`
})

describe('buildManifest', () => {
  it('has an entry for every installer, plus the plain os-arch keys', () => {
    const m = buildManifest(release())
    expect(m.version).toBe('1.0.3')
    expect(m.pub_date).toBe('2026-11-02T00:00:00Z')
    expect(Object.keys(m.platforms).sort()).toEqual(
      [
        'darwin-aarch64',
        'darwin-aarch64-app',
        'darwin-x86_64',
        'darwin-x86_64-app',
        'linux-x86_64',
        'linux-x86_64-appimage',
        'linux-x86_64-deb',
        'linux-x86_64-rpm',
        'windows-x86_64',
        'windows-x86_64-msi',
        'windows-x86_64-nsis'
      ].sort()
    )
    expect(m.platforms['darwin-x86_64']).toEqual({ signature: 'sig of Karen_x64.app.tar.gz', url: 'https://example.com/v1.0.3/Karen_x64.app.tar.gz' })
    expect(m.platforms['linux-x86_64'].url).toMatch(/\.AppImage$/)
    expect(m.platforms['windows-x86_64'].url).toMatch(/-setup\.exe$/)
    expect(m.platforms['linux-x86_64-rpm'].url).toMatch(/\.rpm$/)
  })

  it('does not take a .sig file for the installer itself', () => {
    expect(buildManifest(release()).platforms['linux-x86_64-deb'].url).toMatch(/_amd64\.deb$/)
  })

  it('fails when a platform is missing or unsigned', () => {
    expect(() => buildManifest(release(ASSETS.filter((a) => !a.endsWith('.msi'))))).toThrow(/windows-x86_64-msi/)
    const sigs = signed(ASSETS)
    delete sigs['Karen_aarch64.app.tar.gz']
    expect(() => buildManifest(release(ASSETS, sigs))).toThrow(/darwin-aarch64-app: Karen_aarch64\.app\.tar\.gz has no/)
  })
})

describe('releaseNotes', () => {
  it('drops the install instructions and keeps the generated notes', () => {
    const body = [
      '## Installing on macOS',
      'Karen is not notarized…',
      '- run `xattr`',
      '',
      "## What's Changed",
      '* feat: things by @someone',
      '',
      '**Full Changelog**: v1.0.2...v1.0.3'
    ].join('\n')
    expect(releaseNotes(body)).toBe("## What's Changed\n* feat: things by @someone\n\n**Full Changelog**: v1.0.2...v1.0.3")
  })

  it('handles a body with only the install section, or none', () => {
    expect(releaseNotes('## Installing on macOS\nstuff\n')).toBe('')
    expect(releaseNotes(null)).toBe('')
    expect(releaseNotes('Just notes')).toBe('Just notes')
  })
})
