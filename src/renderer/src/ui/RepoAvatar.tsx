import type { CSSProperties } from 'react'
import { repoHue, repoInitials } from '../util/welcome'

/** Monogram in a colour picked from the repository path (one of the graph lane colours). Styles: home.css. */
export function RepoAvatar({ name, path, size, muted }: { name: string; path: string; size?: 'lg'; muted?: boolean }) {
  return (
    <span
      className={`repo-avatar ${size === 'lg' ? 'lg' : ''} ${muted ? 'muted' : ''}`}
      style={{ '--hue': `var(--lane-${repoHue(path)})` } as CSSProperties}
      aria-hidden
    >
      {repoInitials(name)}
    </span>
  )
}
