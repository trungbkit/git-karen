// Author avatars: Gravatar image when available, otherwise initials on a stable colour.
import { memo, useEffect, useState } from 'react'
import { avatarColor, initials } from '../util/format'

const urlByEmail = new Map<string, string>()
const pending = new Map<string, Promise<string>>()
/** Emails whose Gravatar returned 404 (no avatar) — don't retry this session. */
const missing = new Set<string>()

async function gravatarUrl(email: string): Promise<string> {
  const key = email.trim().toLowerCase()
  const cached = urlByEmail.get(key)
  if (cached) return cached
  let p = pending.get(key)
  if (!p) {
    p = crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)).then((buf) => {
      const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
      const url = `https://www.gravatar.com/avatar/${hex}?d=404&s=64`
      urlByEmail.set(key, url)
      return url
    })
    pending.set(key, p)
  }
  return p
}

interface Props {
  name: string
  email: string
  size: number
  /** Try Gravatar first */
  remote: boolean
  className?: string
}

export const Avatar = memo(function Avatar({ name, email, size, remote, className }: Props) {
  const key = email.trim().toLowerCase()
  const [url, setUrl] = useState<string | null>(() => (remote && !missing.has(key) ? (urlByEmail.get(key) ?? null) : null))
  useEffect(() => {
    if (!remote || missing.has(key)) {
      setUrl(null)
      return
    }
    let alive = true
    void gravatarUrl(key).then((u) => alive && setUrl(u))
    return () => {
      alive = false
    }
  }, [key, remote])

  const style = { width: size, height: size, background: avatarColor(email), fontSize: Math.max(7, Math.round(size * 0.42)) }
  return (
    <span className={`g-avatar ${className ?? ''}`} style={style}>
      {initials(name || email)}
      {url && (
        <img
          src={url}
          alt=""
          draggable={false}
          onError={() => {
            missing.add(key)
            setUrl(null)
          }}
        />
      )}
    </span>
  )
})
