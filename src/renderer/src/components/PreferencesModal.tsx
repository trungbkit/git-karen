import { useEffect, useState, type ReactNode } from 'react'
import { DEFAULT_PREFERENCES, type AiCredential, type AiSettings, type AiStatus, type Preferences } from '@shared/types'
import { useStore } from '../state/store'
import { Modal } from '../ui/Modal'
import { IntegrationsSettings } from './IntegrationsSettings'
import { CliSettings } from './CliSettings'
import { ACCENT_PRESETS, parseHex, THEMES } from '../ui/appearance'
import '../styles/detail.css'

type Section = 'general' | 'ui' | 'tools' | 'ai' | 'identity' | 'integrations'

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'ui', label: 'UI customization' },
  { id: 'tools', label: 'External tools' },
  { id: 'ai', label: 'AI & smart commit' },
  { id: 'identity', label: 'Git identity' },
  { id: 'integrations', label: 'Integrations' }
]

/** A labelled control; wrapping it in the <label> ties the text to the control for screen readers. */
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  )
}

const CREDENTIALS: { id: AiCredential; label: string; hint?: string }[] = [
  { id: 'anthropicOauthToken', label: 'Claude OAuth token', hint: 'Subscription billing. Create one with `claude setup-token`.' },
  { id: 'anthropicApiKey', label: 'Anthropic API key' },
  { id: 'openaiApiKey', label: 'OpenAI API key' },
  { id: 'geminiApiKey', label: 'Gemini API key' }
]
/** `#abc` as `#aabbcc` (the colour input only takes the long form). */
const normalizeHex = (c: string) => `#${parseHex(c)!.map((v) => v.toString(16).padStart(2, '0')).join('')}`

const PROVIDER_LABELS = { anthropic: 'Claude', openai: 'OpenAI', gemini: 'Gemini' } as const

interface Identity {
  name: string
  email: string
}

/** Global signing setup; empty strings are unset keys */
interface SigningConfig {
  format: string
  key: string
  gpgSign: boolean
}

export function PreferencesModal() {
  const prefs = useStore((s) => s.prefs)
  const initialSection = useStore((s) => (s.modal?.kind === 'preferences' ? s.modal.section : undefined))
  const activeRepo = useStore((s) => s.repos[s.activeTab]?.path ?? null)
  const { setPrefs, setModal, toast } = useStore.getState()
  const [section, setSection] = useState<Section>(initialSection ?? 'general')
  const [draft, setDraft] = useState<Preferences>(prefs)
  const [ai, setAi] = useState<AiStatus | null>(null)
  const [aiDraft, setAiDraft] = useState<AiSettings | null>(null)
  /** Typed keys (string) and keys to remove (null); absent = unchanged */
  const [secrets, setSecrets] = useState<Partial<Record<AiCredential, string | null>>>({})
  const [aiTest, setAiTest] = useState<{ state: 'running' | 'ok' | 'error'; message: string } | null>(null)
  const [globalId, setGlobalId] = useState<Identity>({ name: '', email: '' })
  const [repoId, setRepoId] = useState<Identity>({ name: '', email: '' })
  const [loadedIds, setLoadedIds] = useState<{ global: Identity; repo: Identity } | null>(null)
  const [signingCfg, setSigningCfg] = useState<SigningConfig>({ format: '', key: '', gpgSign: false })
  const [loadedSigning, setLoadedSigning] = useState<SigningConfig | null>(null)
  const [signTest, setSignTest] = useState<{ state: 'running' | 'ok' | 'error'; message: string } | null>(null)
  // edited as text so blank lines can be typed; the list drops them
  const [scanDirsText, setScanDirsText] = useState(() => prefs.repoScanDirs.join('\n'))

  useEffect(() => {
    const get = (key: string) => window.git.getConfig(null, key).then((v) => v ?? '', () => '')
    void Promise.all([get('gpg.format'), get('user.signingkey'), get('commit.gpgsign')]).then(([format, key, gpgSign]) => {
      const loaded = { format, key, gpgSign: gpgSign === 'true' }
      setSigningCfg(loaded)
      setLoadedSigning(loaded)
    })
  }, [])

  // signs a throwaway commit object with the settings as typed, before they are saved
  const testSigning = async () => {
    setSignTest({ state: 'running', message: 'Signing a test commit…' })
    try {
      const format = await window.git.testSigning(activeRepo, signingCfg.format || null, signingCfg.key.trim() || null)
      setSignTest({ state: 'ok', message: `Signing works (${format}${signingCfg.key.trim() ? `, key ${signingCfg.key.trim()}` : ''}).` })
    } catch (e) {
      setSignTest({ state: 'error', message: (e as Error).message })
    }
  }

  useEffect(() => {
    const get = (repo: string | null, key: string) => window.git.getConfig(repo, key).then((v) => v ?? '', () => '')
    void (async () => {
      const g = { name: await get(null, 'user.name'), email: await get(null, 'user.email') }
      // Repo-local values: read through the repo, but only keep them when they differ from global.
      const rName = activeRepo ? await get(activeRepo, 'user.name') : ''
      const rEmail = activeRepo ? await get(activeRepo, 'user.email') : ''
      const r = { name: rName !== g.name ? rName : '', email: rEmail !== g.email ? rEmail : '' }
      setGlobalId(g)
      setRepoId(r)
      setLoadedIds({ global: g, repo: r })
    })()
  }, [activeRepo])

  useEffect(() => {
    void window.ai.status().then(
      (s) => {
        setAi(s)
        setAiDraft(s.settings)
      },
      () => undefined
    )
  }, [])

  const setAiSetting = <K extends keyof AiSettings>(key: K, value: AiSettings[K]) => setAiDraft((d) => (d ? { ...d, [key]: value } : d))
  const pendingSecrets = () => Object.fromEntries(Object.entries(secrets).filter(([, v]) => v !== '')) as Partial<Record<AiCredential, string | null>>
  const aiChanged = () => !!aiDraft && (JSON.stringify(aiDraft) !== JSON.stringify(ai?.settings) || Object.keys(pendingSecrets()).length > 0)

  const saveAi = async () => {
    if (!aiDraft || !aiChanged()) return ai
    const status = await window.ai.update(aiDraft, pendingSecrets())
    setAi(status)
    setAiDraft(status.settings)
    setSecrets({})
    return status
  }

  const testAi = async () => {
    setAiTest({ state: 'running', message: 'Sending a test request…' })
    try {
      const status = await saveAi()
      if (!status?.active) throw new Error('No provider has a credential.')
      const reply = await window.ai.complete('Reply with the single word OK.', 16)
      setAiTest({ state: 'ok', message: `${PROVIDER_LABELS[status.active.provider]} (${status.active.model}) replied: ${reply.trim().slice(0, 60) || '(empty)'}` })
    } catch (e) {
      setAiTest({ state: 'error', message: (e as Error).message })
    }
  }

  const set = <K extends keyof Preferences>(key: K, value: Preferences[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const close = () => setModal(null)

  const save = async () => {
    try {
      await setPrefs(draft)
      await saveAi()
      if (loadedIds) {
        if (globalId.name !== loadedIds.global.name) await window.git.setConfig(null, 'user.name', globalId.name, true)
        if (globalId.email !== loadedIds.global.email) await window.git.setConfig(null, 'user.email', globalId.email, true)
        if (activeRepo) {
          if (repoId.name !== loadedIds.repo.name && repoId.name) await window.git.setConfig(activeRepo, 'user.name', repoId.name)
          if (repoId.email !== loadedIds.repo.email && repoId.email) await window.git.setConfig(activeRepo, 'user.email', repoId.email)
        }
      }
      if (loadedSigning) {
        const put = (key: string, value: string, was: string) =>
          value === was ? undefined : value ? window.git.setConfig(null, key, value, true) : window.git.unsetConfig(null, key, true)
        await put('gpg.format', signingCfg.format, loadedSigning.format)
        await put('user.signingkey', signingCfg.key.trim(), loadedSigning.key)
        if (signingCfg.gpgSign !== loadedSigning.gpgSign) await window.git.setConfig(null, 'commit.gpgsign', String(signingCfg.gpgSign), true)
      }
      toast({ kind: 'success', title: 'Preferences saved' })
      close()
    } catch (e) {
      toast({ kind: 'error', title: 'Could not save preferences', message: (e as Error).message })
    }
  }

  const num = (key: 'autoFetchMinutes' | 'commitLimit' | 'fontSize', min: number, max: number) => (
    <input
      type="number"
      min={min}
      max={max}
      value={draft[key]}
      onChange={(e) => {
        const v = Number(e.target.value)
        if (!Number.isNaN(v)) set(key, Math.max(min, Math.min(max, Math.round(v))))
      }}
    />
  )
  const check = (key: 'rememberTabs' | 'pushAfterCommit' | 'conventionalCommits' | 'showAuthorColumn' | 'showDateColumn' | 'showShaColumn' | 'showChangesColumn' | 'showCommitDescription' | 'showAvatars' | 'showWorktreeWips' | 'syntaxHighlighting' | 'useInAppTerminal', label: string) => (
    <label className="check">
      <input type="checkbox" checked={draft[key]} onChange={(e) => set(key, e.target.checked)} />
      {label}
    </label>
  )
  const text = (key: 'defaultBranchName' | 'externalEditor' | 'editorLineArgs' | 'externalTerminal' | 'diffTool' | 'mergeTool' | 'smartCommitTargets' | 'protectedBranches', placeholder?: string) => (
    <input value={draft[key]} placeholder={placeholder} onChange={(e) => set(key, e.target.value)} />
  )

  return (
    <Modal
      title="Preferences"
      onClose={close}
      width={720}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <div className="prefs">
        <nav className="prefs-nav" aria-label="Preference sections">
          {SECTIONS.map((s) => (
            <button key={s.id} className={section === s.id ? 'on' : ''} aria-current={section === s.id ? 'page' : undefined} onClick={() => setSection(s.id)}>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="prefs-body">
          {section === 'general' && (
            <>
              <Field label="Auto-fetch interval (minutes)" hint="0 disables auto-fetch. Maximum 60.">
                {num('autoFetchMinutes', 0, 60)}
              </Field>
              <Field label="Default branch name" hint="Used when initializing new repositories.">
                {text('defaultBranchName', 'main')}
              </Field>
              <Field label="Commits loaded in graph" hint="Larger values may slow down very big repositories.">
                {num('commitLimit', 100, 100000)}
              </Field>
              {check('rememberTabs', 'Reopen tabs on startup')}
              {check('pushAfterCommit', 'Push after each commit')}
              {check('conventionalCommits', 'Conventional Commits: type and scope pickers in the commit composer, and a format check')}
              <Field
                label="Find repositories in"
                hint="One folder per line; ~ is your home folder. The welcome screen lists the repositories in these folders and up to two levels below them (hidden folders and node_modules are skipped)."
              >
                <textarea
                  rows={3}
                  spellCheck={false}
                  value={scanDirsText}
                  placeholder={DEFAULT_PREFERENCES.repoScanDirs.join('\n')}
                  onChange={(e) => {
                    setScanDirsText(e.target.value)
                    set('repoScanDirs', e.target.value.split('\n').map((d) => d.trim()).filter(Boolean))
                  }}
                />
              </Field>
              <CliSettings />
            </>
          )}
          {section === 'ui' && (
            <>
              <div className="row2">
                <Field label="Theme" hint={draft.theme === 'system' ? 'Dark or Light, following the system setting as it changes.' : undefined}>
                  <select value={draft.theme} onChange={(e) => set('theme', e.target.value as Preferences['theme'])}>
                    <option value="system">Match system (Dark / Light)</option>
                    {THEMES.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Date format">
                  <select value={draft.dateFormat} onChange={(e) => set('dateFormat', e.target.value as Preferences['dateFormat'])}>
                    <option value="relative">Relative (2 hours ago)</option>
                    <option value="absolute">Absolute (date and time)</option>
                  </select>
                </Field>
              </div>
              <div className="field">
                <span className="field-label" id="accent-label">
                  Accent color
                </span>
                <div className="accent-picker" role="group" aria-labelledby="accent-label">
                  <button className={`accent-swatch theme ${draft.accentColor ? '' : 'on'}`} aria-pressed={!draft.accentColor} title="The theme's own accent" onClick={() => set('accentColor', '')}>
                    Theme
                  </button>
                  {ACCENT_PRESETS.map((c) => (
                    <button
                      key={c}
                      className={`accent-swatch ${draft.accentColor.toLowerCase() === c ? 'on' : ''}`}
                      aria-pressed={draft.accentColor.toLowerCase() === c}
                      aria-label={`Accent ${c}`}
                      title={c}
                      style={{ background: c }}
                      onClick={() => set('accentColor', c)}
                    />
                  ))}
                  <input
                    type="color"
                    aria-label="Custom accent color"
                    title="Pick any color"
                    value={parseHex(draft.accentColor) ? normalizeHex(draft.accentColor) : '#5e91ff'}
                    onChange={(e) => set('accentColor', e.target.value)}
                  />
                </div>
                <span className="hint">Buttons, selection, focus rings and links. Text on accent buttons switches to dark when the color is light.</span>
              </div>
              <div className="row2">
                <Field label="Font size (px)">{num('fontSize', 10, 20)}</Field>
                <Field label="Density" hint="Row height of the graph, file lists and the left panel.">
                  <select value={draft.density} onChange={(e) => set('density', e.target.value as Preferences['density'])}>
                    <option value="comfortable">Comfortable</option>
                    <option value="compact">Compact</option>
                  </select>
                </Field>
              </div>
              {check('syntaxHighlighting', 'Syntax highlighting in diff, blame and merge views')}
              <h3>Left panel</h3>
              <Field label="Sort branches">
                <select value={draft.branchSort} onChange={(e) => set('branchSort', e.target.value as Preferences['branchSort'])}>
                  <option value="name">By name</option>
                  <option value="date">Most recent commit first</option>
                </select>
              </Field>
              <h3>Commit graph</h3>
              <Field label="Graph style">
                <select value={draft.graphMode} onChange={(e) => set('graphMode', e.target.value as Preferences['graphMode'])}>
                  <option value="rich">Rich (author avatars)</option>
                  <option value="compact">Compact (small nodes, narrow lanes)</option>
                </select>
              </Field>
              {check('showAvatars', 'Show author avatars from Gravatar (initials otherwise)')}
              {check('showWorktreeWips', 'Show a WIP row for each worktree with uncommitted changes')}
              {check('showCommitDescription', 'Show commit description in graph')}
              {check('showAuthorColumn', 'Show author column')}
              {check('showChangesColumn', 'Show changes column')}
              {check('showDateColumn', 'Show commit date/time column')}
              {check('showShaColumn', 'Show commit SHA column')}
            </>
          )}
          {section === 'tools' && (
            <>
              <Field label="External editor command" hint="Executable used to open files and repositories, e.g. code, cursor, subl, idea.">
                {text('externalEditor', 'code')}
              </Field>
              <Field
                label="Open at line arguments"
                hint="How the editor opens a file at a line (clicking a line number in a diff), with {file} and {line}. Leave empty for the usual form of code, cursor, subl, zed, idea and other JetBrains IDEs, vim, mate."
              >
                {text('editorLineArgs', 'e.g. -g {file}:{line} · {file}:{line} · --line {line} {file}')}
              </Field>
              {check('useInAppTerminal', 'Use the built-in terminal (Terminal button and Ctrl+` open it)')}
              <Field label="External terminal" hint="macOS: application name (Terminal, iTerm, Warp). Windows/Linux: executable.">
                {text('externalTerminal', 'Terminal')}
              </Field>
              <Field label="Diff tool" hint="A git difftool name (git config diff.tool). Leave empty to use the built-in diff.">
                {text('diffTool', 'e.g. opendiff, meld, bc')}
              </Field>
              <Field label="Merge tool" hint="A git mergetool name (git config merge.tool). Leave empty to use the built-in merge tool.">
                {text('mergeTool', 'e.g. opendiff, meld, bc')}
              </Field>
            </>
          )}
          {section === 'ai' && aiDraft && ai && (
            <>
              <span className={ai.active ? 'hint' : 'field-warning'}>
                {ai.active
                  ? `AI requests go to ${PROVIDER_LABELS[ai.active.provider]} (${ai.active.model}) with the ${CREDENTIALS.find((c) => c.id === ai.active!.credential)?.label}. Your diffs are sent to that provider.`
                  : 'No AI provider is set up: commit messages are yours to write and PR texts fall back to the commit subjects.'}
              </span>
              <Field label="Provider" hint="Automatic uses the first one with a credential: Claude, then OpenAI, then Gemini.">
                <select value={aiDraft.provider} onChange={(e) => setAiSetting('provider', e.target.value as AiSettings['provider'])}>
                  <option value="auto">Automatic</option>
                  <option value="anthropic">Claude (Anthropic)</option>
                  <option value="openai">OpenAI</option>
                  <option value="gemini">Gemini</option>
                </select>
              </Field>
              <h3>Credentials</h3>
              <span className="hint">
                Stored in a file only you can read and never shown again. Leave a field empty to use the environment variable (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY,
                OPENAI_API_KEY, GEMINI_API_KEY), including ones exported from your shell profile.
              </span>
              {CREDENTIALS.map((c) => {
                const info = ai.secrets[c.id]
                const cleared = secrets[c.id] === null
                const placeholder = cleared
                  ? 'Will be removed'
                  : info.source === 'app'
                    ? `Saved (${info.hint})`
                    : info.source === 'env'
                      ? `From $${info.hint}`
                      : 'Not set'
                return (
                  <Field key={c.id} label={c.label} hint={c.hint}>
                    <div className="ai-secret">
                      <input
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        value={secrets[c.id] ?? ''}
                        placeholder={placeholder}
                        onChange={(e) => setSecrets((s) => ({ ...s, [c.id]: e.target.value }))}
                      />
                      {info.source === 'app' && !cleared && (
                        <button className="btn small" onClick={() => setSecrets((s) => ({ ...s, [c.id]: null }))}>
                          Remove
                        </button>
                      )}
                    </div>
                  </Field>
                )
              })}
              <h3>Models</h3>
              <div className="row2">
                <Field label="Claude model">
                  <input value={aiDraft.anthropicModel} placeholder={ai.defaultModels.anthropic} onChange={(e) => setAiSetting('anthropicModel', e.target.value.trim())} />
                </Field>
                <Field label="OpenAI model">
                  <input value={aiDraft.openaiModel} placeholder={ai.defaultModels.openai} onChange={(e) => setAiSetting('openaiModel', e.target.value.trim())} />
                </Field>
              </div>
              <div className="row2">
                <Field label="Gemini model">
                  <input value={aiDraft.geminiModel} placeholder={ai.defaultModels.gemini} onChange={(e) => setAiSetting('geminiModel', e.target.value.trim())} />
                </Field>
                <span />
              </div>
              <h3>Network</h3>
              <span className="hint">Base URLs route requests through a gateway or mirror. Proxies come from HTTPS_PROXY and NO_PROXY.</span>
              <div className="row2">
                <Field label="Anthropic base URL">
                  <input value={aiDraft.anthropicBaseUrl} placeholder="https://api.anthropic.com" onChange={(e) => setAiSetting('anthropicBaseUrl', e.target.value.trim())} />
                </Field>
                <Field label="OpenAI base URL">
                  <input value={aiDraft.openaiBaseUrl} placeholder="https://api.openai.com" onChange={(e) => setAiSetting('openaiBaseUrl', e.target.value.trim())} />
                </Field>
              </div>
              <div className="row2">
                <Field label="Gemini base URL">
                  <input value={aiDraft.geminiBaseUrl} placeholder="https://generativelanguage.googleapis.com" onChange={(e) => setAiSetting('geminiBaseUrl', e.target.value.trim())} />
                </Field>
                <span />
              </div>
              <div className="row2">
                <Field label="Request timeout (seconds)">
                  <input type="number" min={5} max={600} value={aiDraft.timeoutSeconds} onChange={(e) => setAiSetting('timeoutSeconds', Math.max(5, Math.min(600, Math.round(Number(e.target.value) || 30))))} />
                </Field>
                <Field label="Attempts per request" hint="Network errors, timeouts, 429 and 5xx are retried with backoff.">
                  <input type="number" min={1} max={10} value={aiDraft.attempts} onChange={(e) => setAiSetting('attempts', Math.max(1, Math.min(10, Math.round(Number(e.target.value) || 3))))} />
                </Field>
              </div>
              <div className="ai-test">
                <button className="btn" disabled={aiTest?.state === 'running'} onClick={() => void testAi()}>
                  Save &amp; test
                </button>
                {aiTest && <span className={aiTest.state === 'error' ? 'field-error' : 'hint'}>{aiTest.message}</span>}
              </div>
              <h3>Smart commit</h3>
              <Field label="Default pull request targets" hint="Comma-separated branches the smart commit opens PRs against.">
                {text('smartCommitTargets', 'uat,main')}
              </Field>
              <Field label="Protected branches" hint="Comma-separated. Smart commit never merges into these locally; they are merged through GitHub.">
                {text('protectedBranches', 'main,master,uat,staging')}
              </Field>
            </>
          )}
          {section === 'integrations' && <IntegrationsSettings repo={activeRepo} issueLinks={draft.issueLinks} onIssueLinks={(v) => set('issueLinks', v)} />}
          {section === 'identity' && (
            <>
              <h3>Global (~/.gitconfig)</h3>
              <div className="row2">
                <Field label="Name">
                  <input value={globalId.name} onChange={(e) => setGlobalId({ ...globalId, name: e.target.value })} />
                </Field>
                <Field label="Email">
                  <input value={globalId.email} onChange={(e) => setGlobalId({ ...globalId, email: e.target.value })} />
                </Field>
              </div>
              {activeRepo ? (
                <>
                  <h3>This repository</h3>
                  <span className="hint">Overrides the global identity for {activeRepo}. Leave empty to use the global identity.</span>
                  <div className="row2">
                    <Field label="Name">
                      <input value={repoId.name} placeholder={globalId.name} onChange={(e) => setRepoId({ ...repoId, name: e.target.value })} />
                    </Field>
                    <Field label="Email">
                      <input value={repoId.email} placeholder={globalId.email} onChange={(e) => setRepoId({ ...repoId, email: e.target.value })} />
                    </Field>
                  </div>
                </>
              ) : (
                <span className="hint">Open a repository to set a per-repository identity.</span>
              )}
              <h3>Commit signing (global)</h3>
              <div className="row2">
                <Field label="Signature format" hint="gpg.format">
                  <select value={signingCfg.format} onChange={(e) => setSigningCfg({ ...signingCfg, format: e.target.value })}>
                    <option value="">openpgp (default)</option>
                    <option value="openpgp">openpgp</option>
                    <option value="ssh">ssh</option>
                    <option value="x509">x509</option>
                  </select>
                </Field>
                <Field label="Signing key" hint={signingCfg.format === 'ssh' ? 'user.signingkey: path to a public key, or the key itself' : 'user.signingkey: key id (empty uses your email)'}>
                  <input
                    value={signingCfg.key}
                    placeholder={signingCfg.format === 'ssh' ? '~/.ssh/id_ed25519.pub' : 'ABCDEF1234567890'}
                    onChange={(e) => setSigningCfg({ ...signingCfg, key: e.target.value })}
                  />
                </Field>
              </div>
              <label className="check">
                <input type="checkbox" checked={signingCfg.gpgSign} onChange={(e) => setSigningCfg({ ...signingCfg, gpgSign: e.target.checked })} />
                Sign every commit by default (commit.gpgsign)
              </label>
              <div className="ai-test">
                <button className="btn small" disabled={signTest?.state === 'running'} onClick={() => void testSigning()}>
                  Test signing
                </button>
                {signTest && <span className={signTest.state === 'error' ? 'field-error' : 'hint'}>{signTest.message}</span>}
              </div>
              <span className="hint">A repository's own config can override these. Signing uses gpg, gpgsm or ssh-keygen as configured in git.</span>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
