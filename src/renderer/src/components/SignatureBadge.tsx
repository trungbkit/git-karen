// "Signed" badge for the commit detail panel: whether a commit carries a GPG/SSH/X.509 signature and whether git
// could verify it. Unsigned commits show nothing.
import { useEffect, useState } from 'react'
import type { CommitSignature } from '@shared/types'
import { Icon } from '../ui/Icon'
import '../styles/staging.css'

// A commit's signature never changes; its verification only does when keys change, which a restart picks up.
const cache = new Map<string, CommitSignature | null>()

const LABELS: Record<CommitSignature['status'], { text: string; tone: 'good' | 'warn' | 'bad' | 'muted'; hint: string }> = {
  good: { text: 'Signed', tone: 'good', hint: 'Good signature' },
  untrusted: { text: 'Signed', tone: 'warn', hint: 'Good signature from a key that is not trusted' },
  expired: { text: 'Signed · expired', tone: 'warn', hint: 'Good signature, but the signature or key has expired' },
  revoked: { text: 'Revoked key', tone: 'bad', hint: 'Signed with a revoked key' },
  bad: { text: 'Bad signature', tone: 'bad', hint: 'The signature does not match the commit' },
  unverified: { text: 'Signed · unverified', tone: 'muted', hint: 'Git cannot check this signature (unknown key, or no gpg.ssh.allowedSignersFile)' }
}

export function SignatureBadge({ repo, sha }: { repo: string; sha: string }) {
  const key = `${repo}\0${sha}`
  const [sig, setSig] = useState<{ key: string; value: CommitSignature | null } | null>(() => (cache.has(key) ? { key, value: cache.get(key)! } : null))

  useEffect(() => {
    if (cache.has(key)) return setSig({ key, value: cache.get(key)! })
    let cancelled = false
    window.git.signatureStatus(repo, sha).then(
      (value) => {
        cache.set(key, value)
        if (!cancelled) setSig({ key, value })
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [key, repo, sha])

  const value = sig?.key === key ? sig.value : null
  if (!value) return null
  const label = LABELS[value.status]
  const title = [label.hint, `${value.format.toUpperCase()} signature`, value.signer, value.key && `Key ${value.key}`].filter(Boolean).join('\n')
  return (
    <span className={`sig-badge ${label.tone}`} title={title}>
      <Icon name="shield" size={11} /> {label.text}
    </span>
  )
}
