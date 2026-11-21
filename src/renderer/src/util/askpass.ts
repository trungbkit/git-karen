// What a git or ssh credential prompt asks for, so the dialog can show a fitting title and field. Pure.

export type PromptKind = 'username' | 'password' | 'passphrase' | 'hostKey' | 'confirm' | 'notice' | 'text'

export interface PromptView {
  kind: PromptKind
  /** Hide what is typed */
  secret: boolean
  title: string
  /** The host (or SSH key file) the prompt names, when it names one */
  subject: string | null
}

/**
 * Classify `prompt` (git's "Username for 'https://host': ", ssh's "Enter passphrase for key '…': ", the host key
 * question, …). `sshPrompt` is ssh's SSH_ASKPASS_PROMPT hint. Unknown prompts are treated as secrets: showing a
 * username hidden is a nuisance, showing a password is a leak.
 */
export function describePrompt(prompt: string, sshPrompt?: string | null): PromptView {
  const p = prompt.trim()
  if (sshPrompt === 'none') return { kind: 'notice', secret: false, title: 'SSH', subject: null }
  if (/continue connecting \(yes\/no/i.test(p)) {
    const host = /authenticity of host '([^']+)'/i.exec(p)?.[1] ?? null
    return { kind: 'hostKey', secret: false, title: 'Trust this SSH server?', subject: host }
  }
  if (sshPrompt === 'confirm') return { kind: 'confirm', secret: false, title: 'Confirm', subject: null }
  let m = /^Username for '([^']+)'/i.exec(p)
  if (m) return { kind: 'username', secret: false, title: `Sign in to ${hostOf(m[1])}`, subject: m[1] }
  m = /^Password for '([^']+)'/i.exec(p)
  if (m) return { kind: 'password', secret: true, title: `Password for ${hostOf(m[1])}`, subject: m[1] }
  if (/passphrase/i.test(p)) {
    const key = /for key '([^']+)'/i.exec(p)?.[1] ?? null
    return { kind: 'passphrase', secret: true, title: 'Unlock SSH key', subject: key }
  }
  m = /^(\S+@\S+?)'s password/i.exec(p)
  if (m) return { kind: 'password', secret: true, title: `Password for ${m[1]}`, subject: m[1] }
  return { kind: 'text', secret: true, title: 'Git needs your input', subject: null }
}

/** "https://alice@github.com/x" -> "github.com" */
function hostOf(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)/i.exec(url)
  return m ? m[1] : url
}
