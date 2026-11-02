// Preferences > Integrations (plan 07.1, 07.5): personal access tokens per host (kept in the OS keychain, applied
// immediately) or, for GitHub hosts, the GitHub CLI's login; self-hosted hosts; and the active repository's issue link
// rules (saved with the other preferences).
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { GhStatus, HostConfig, HostingAccount, HostingKind, IssueLinkConfig, IssueLinkRule } from '@shared/integrations'
import { useHosting, useRepoHosting } from '../state/hosting'
import { compileRules, linkify, validateRule } from '../util/issueLinks'
import { basename } from '../util/format'
import '../styles/detail.css'
import '../styles/hosting.css'

const KINDS: { id: HostingKind; label: string }[] = [
  { id: 'github', label: 'GitHub Enterprise' },
  { id: 'gitlab', label: 'GitLab (self-managed)' },
  { id: 'bitbucket', label: 'Bitbucket Server (web links only)' },
  { id: 'azure', label: 'Azure DevOps Server (web links only)' }
]

const TOKEN_HINT: Partial<Record<HostingKind, string>> = {
  github: 'Classic token with the "repo" scope, or a fine-grained token with Pull requests (read/write), Commit statuses and Checks (read).',
  gitlab: 'Personal access token with the "api" scope.'
}

function tokenPage(a: HostingAccount): string | null {
  if (a.kind === 'github') return `${a.webUrl}/settings/tokens`
  if (a.kind === 'gitlab') return `${a.webUrl}/-/user_settings/personal_access_tokens`
  return null
}

type Status = { state: 'running' | 'ok' | 'error'; message: string }

/** The host gh knows an account by: its web host (an SSH alias of github.com is github.com to gh). */
function ghHostOf(a: HostingAccount): string {
  try {
    return new URL(a.webUrl).host.toLowerCase()
  } catch {
    return a.host
  }
}

function accountStatus(a: HostingAccount): { text: string; ok: boolean } {
  if (a.gh) {
    if (!a.hasToken) return { text: 'GitHub CLI not signed in', ok: false }
    return { text: a.user ? `Connected as ${a.user} · GitHub CLI` : 'Using GitHub CLI', ok: true }
  }
  if (a.hasToken) return { text: a.user ? `Connected as ${a.user}` : 'Token saved', ok: true }
  return { text: a.apiSupported ? 'Not connected' : 'Web links only', ok: false }
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      className="issue-link"
      onClick={(e) => {
        e.preventDefault()
        void window.app.openExternal(href)
      }}
    >
      {children}
    </a>
  )
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  )
}

interface Props {
  repo: string | null
  issueLinks: Record<string, IssueLinkConfig>
  onIssueLinks(next: Record<string, IssueLinkConfig>): void
}

export function IntegrationsSettings({ repo, issueLinks, onIssueLinks }: Props) {
  const [accounts, setAccounts] = useState<HostingAccount[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tokens, setTokens] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<Record<string, Status>>({})
  const [newHost, setNewHost] = useState<HostConfig>({ host: '', kind: 'gitlab', apiUrl: '', webUrl: '' })
  const [hostError, setHostError] = useState<string | null>(null)
  const [gh, setGh] = useState<GhStatus | null>(null)
  const [ghUsers, setGhUsers] = useState<Record<string, string>>({})

  const loadGh = () => void window.integrations.ghStatus().then(setGh, () => setGh({ installed: false, version: null, accounts: [], error: null }))

  useEffect(() => {
    void window.integrations.accounts().then(setAccounts, (e: Error) => setLoadError(e.message))
    loadGh()
  }, [])

  const updated = (list: HostingAccount[]) => {
    setAccounts(list)
    // repo info, PR lists and CI depend on which hosts have tokens
    useHosting.getState().invalidate()
  }
  const setHostStatus = (host: string, s: Status | null) =>
    setStatus((m) => {
      const next = { ...m }
      if (s) next[host] = s
      else delete next[host]
      return next
    })

  const test = async (host: string) => {
    setHostStatus(host, { state: 'running', message: 'Connecting…' })
    try {
      const v = await window.integrations.test(host)
      setHostStatus(host, { state: 'ok', message: `Connected as ${v.user}${v.name ? ` (${v.name})` : ''}` })
      setAccounts(await window.integrations.accounts())
    } catch (e) {
      setHostStatus(host, { state: 'error', message: (e as Error).message })
    }
  }

  const saveToken = async (host: string) => {
    const token = tokens[host]?.trim()
    if (!token) return
    try {
      updated(await window.integrations.setToken(host, token))
      setTokens((t) => ({ ...t, [host]: '' }))
      await test(host)
    } catch (e) {
      setHostStatus(host, { state: 'error', message: (e as Error).message })
    }
  }

  const removeToken = async (host: string) => {
    try {
      updated(await window.integrations.setToken(host, null))
      setHostStatus(host, null)
    } catch (e) {
      setHostStatus(host, { state: 'error', message: (e as Error).message })
    }
  }

  const setGhMode = async (a: HostingAccount, enabled: boolean, user: string | null) => {
    setHostStatus(a.host, enabled ? { state: 'running', message: 'Asking the GitHub CLI…' } : null)
    try {
      updated(await window.integrations.useGh(a.host, enabled, user))
      if (enabled) await test(a.host)
    } catch (e) {
      setHostStatus(a.host, { state: 'error', message: (e as Error).message })
    }
  }

  const removeHost = async (host: string) => {
    try {
      updated(await window.integrations.removeHost(host))
    } catch (e) {
      setHostStatus(host, { state: 'error', message: (e as Error).message })
    }
  }

  const addHost = async () => {
    setHostError(null)
    try {
      updated(await window.integrations.saveHost(newHost))
      setNewHost({ host: '', kind: newHost.kind, apiUrl: '', webUrl: '' })
    } catch (e) {
      setHostError((e as Error).message)
    }
  }

  return (
    <>
      <span className="hint">
        Pull requests, CI status and pull request creation use your own personal access tokens, sent only to the host they belong to. Tokens are stored in the
        system keychain, never in a file, and take effect as soon as you save them. GitHub hosts can use the GitHub CLI’s login (<code>gh auth login</code>) instead.
      </span>
      {loadError && <span className="field-error">{loadError}</span>}
      {accounts?.map((a) => {
        const st = status[a.host]
        const page = tokenPage(a)
        const head = accountStatus(a)
        const ghHost = ghHostOf(a)
        const ghAccounts = gh?.accounts.filter((g) => g.host === ghHost) ?? []
        // '' = gh's active account
        const ghUser = ghUsers[a.host] ?? a.ghUser ?? ''
        const ghPicker = ghAccounts.length > 1 && (
          <select
            aria-label="GitHub CLI account"
            value={ghUser}
            onChange={(e) => {
              setGhUsers((m) => ({ ...m, [a.host]: e.target.value }))
              if (a.gh) void setGhMode(a, true, e.target.value || null)
            }}
          >
            <option value="">Active gh account ({ghAccounts.find((g) => g.active)?.login ?? 'none'})</option>
            {ghAccounts.map((g) => (
              <option key={g.login} value={g.login}>
                {g.login}
              </option>
            ))}
          </select>
        )
        return (
          <div key={a.host} className="int-account">
            <div className="int-account-head">
              <span className="host">{a.host}</span>
              <span className="hint">{a.builtIn ? a.label : `${a.label} · ${a.apiUrl}`}</span>
              <span className={`status ${head.ok ? 'ok' : ''}`}>{head.text}</span>
            </div>
            {a.gh && (
              <>
                <div className="int-row">
                  <span className="int-gh-label">Token from the GitHub CLI{ghPicker ? '' : a.ghUser ? ` (${a.ghUser})` : ''}</span>
                  {ghPicker}
                  <button className="btn small" disabled={st?.state === 'running'} onClick={() => void test(a.host)}>
                    Test connection
                  </button>
                  <button className="btn small" onClick={() => void setGhMode(a, false, null)}>
                    Use a token instead
                  </button>
                </div>
                {a.ghError && !st && <span className="field-error">{a.ghError}</span>}
              </>
            )}
            {a.apiSupported && !a.gh && (
              <div className="int-row">
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={a.hasToken ? 'Replace token' : 'Personal access token'}
                  value={tokens[a.host] ?? ''}
                  onChange={(e) => setTokens((t) => ({ ...t, [a.host]: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && void saveToken(a.host)}
                />
                <button className="btn small" disabled={!tokens[a.host]?.trim()} onClick={() => void saveToken(a.host)}>
                  Save token
                </button>
                <button className="btn small" disabled={!a.hasToken || st?.state === 'running'} onClick={() => void test(a.host)}>
                  Test connection
                </button>
                {a.hasToken && (
                  <button className="btn small" onClick={() => void removeToken(a.host)}>
                    Remove token
                  </button>
                )}
              </div>
            )}
            {st && <span className={st.state === 'error' ? 'field-error' : 'hint'}>{st.message}</span>}
            {a.apiSupported && !a.gh && (
              <span className="hint">
                {TOKEN_HINT[a.kind]} {page && <ExternalLink href={page}>Create one…</ExternalLink>}
              </span>
            )}
            {a.kind === 'github' && !a.gh && (
              <div className="int-row">
                {gh === null ? (
                  <span className="hint">Looking for the GitHub CLI…</span>
                ) : !gh.installed ? (
                  <span className="hint">
                    Or connect with the GitHub CLI: install <ExternalLink href="https://cli.github.com">gh</ExternalLink>, run <code>gh auth login</code>, then{' '}
                    <a className="issue-link" onClick={loadGh}>
                      check again
                    </a>
                    .
                  </span>
                ) : ghAccounts.length === 0 && !gh.error ? (
                  <span className="hint">
                    Or use the GitHub CLI: run <code>gh auth login --hostname {ghHost}</code> in a terminal, then{' '}
                    <a className="issue-link" onClick={loadGh}>
                      check again
                    </a>
                    .
                  </span>
                ) : (
                  <>
                    <span className="int-gh-label">
                      Or use the GitHub CLI{ghAccounts.length === 1 ? ` (signed in as ${ghAccounts[0].login})` : ''}
                      {gh.error && <span className="hint"> · {gh.error}</span>}
                    </span>
                    {ghPicker}
                    <button className="btn small" disabled={st?.state === 'running'} onClick={() => void setGhMode(a, true, ghUser || null)}>
                      Use GitHub CLI
                    </button>
                  </>
                )}
              </div>
            )}
            {!a.builtIn && (
              <div>
                <button className="btn small ghost" onClick={() => void removeHost(a.host)}>
                  Remove host
                </button>
              </div>
            )}
          </div>
        )
      })}

      <h3>Self-hosted host</h3>
      <span className="hint">
        For GitHub Enterprise, self-managed GitLab, or an SSH alias (e.g. github-work) of a public host. The host is matched against your remote URLs. Leave the URLs empty
        for the defaults (https://host, and /api/v3 or /api/v4).
      </span>
      <div className="row2">
        <Field label="Host">
          <input value={newHost.host} placeholder="gitlab.example.com" onChange={(e) => setNewHost({ ...newHost, host: e.target.value })} />
        </Field>
        <Field label="Type">
          <select value={newHost.kind} onChange={(e) => setNewHost({ ...newHost, kind: e.target.value as HostingKind })}>
            {KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="row2">
        <Field label="Web URL">
          <input value={newHost.webUrl} placeholder={newHost.host ? `https://${newHost.host.trim()}` : 'https://gitlab.example.com'} onChange={(e) => setNewHost({ ...newHost, webUrl: e.target.value })} />
        </Field>
        <Field label="API URL">
          <input value={newHost.apiUrl} placeholder={newHost.kind === 'github' ? 'https://host/api/v3' : newHost.kind === 'gitlab' ? 'https://host/api/v4' : ''} onChange={(e) => setNewHost({ ...newHost, apiUrl: e.target.value })} />
        </Field>
      </div>
      <div className="ai-test">
        <button className="btn" disabled={!newHost.host.trim()} onClick={() => void addHost()}>
          Add host
        </button>
        {hostError && <span className="field-error">{hostError}</span>}
      </div>

      {repo ? <IssueLinkSettings repo={repo} issueLinks={issueLinks} onIssueLinks={onIssueLinks} /> : <span className="hint">Open a repository to set up its issue links.</span>}
    </>
  )
}

const EMPTY: IssueLinkConfig = { rules: [], providerLinks: true }

function IssueLinkSettings({ repo, issueLinks, onIssueLinks }: { repo: string; issueLinks: Record<string, IssueLinkConfig>; onIssueLinks: Props['onIssueLinks'] }) {
  const info = useRepoHosting(repo)
  const config = issueLinks[repo] ?? EMPTY
  const [sample, setSample] = useState('Fix #12, see JIRA-345')
  const update = (patch: Partial<IssueLinkConfig>) => onIssueLinks({ ...issueLinks, [repo]: { ...config, ...patch } })
  const setRule = (i: number, rule: IssueLinkRule) => update({ rules: config.rules.map((r, j) => (j === i ? rule : r)) })
  const preview = useMemo(
    () => linkify(sample, compileRules(config, info ? { kind: info.kind, webUrl: info.webUrl, issueUrl: info.issueUrl } : null)),
    [sample, config, info]
  )

  return (
    <>
      <h3>Issue links for {basename(repo)}</h3>
      <span className="hint">
        {info
          ? `${info.label} repository ${info.path} (remote ${info.remote}).`
          : info === null
            ? 'The remote is not on a recognized hosting provider, so only your own rules apply.'
            : 'Detecting the hosting provider…'}{' '}
        Links apply to commit messages in the graph and commit details.
      </span>
      <label className="check">
        <input type="checkbox" checked={config.providerLinks} onChange={(e) => update({ providerLinks: e.target.checked })} />
        Link #123{info?.kind === 'gitlab' ? ' and !123' : ''} to the provider’s issues{info?.kind === 'gitlab' ? ' and merge requests' : ''}
      </label>
      {config.rules.map((r, i) => {
        const err = validateRule(r)
        return (
          <div key={i}>
            <div className="int-rule">
              <input value={r.pattern} placeholder="JIRA-\d+" aria-label="Pattern (regular expression)" spellCheck={false} onChange={(e) => setRule(i, { ...r, pattern: e.target.value })} />
              <input value={r.url} placeholder="https://jira.example.com/browse/$0" aria-label="Link URL" spellCheck={false} onChange={(e) => setRule(i, { ...r, url: e.target.value })} />
              <button className="btn small" onClick={() => update({ rules: config.rules.filter((_, j) => j !== i) })}>
                Remove
              </button>
            </div>
            {err && <span className="field-error">{err}</span>}
          </div>
        )
      })}
      <div className="ai-test">
        <button className="btn small" onClick={() => update({ rules: [...config.rules, { pattern: '', url: '' }] })}>
          Add rule
        </button>
        <span className="hint">A regular expression and a URL; $0 is the whole match, $1…$9 its groups.</span>
      </div>
      <Field label="Try it">
        <input value={sample} onChange={(e) => setSample(e.target.value)} />
      </Field>
      <div className="int-preview">
        {preview.map((s, i) =>
          s.url ? (
            <a key={i} className="issue-link" title={s.url} onClick={() => void window.app.openExternal(s.url!)}>
              {s.text}
            </a>
          ) : (
            <span key={i}>{s.text}</span>
          )
        )}
      </div>
    </>
  )
}
