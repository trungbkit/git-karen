// Original stroke icon set, 16x16 grid, drawn with currentColor.
import type { CSSProperties, ReactNode } from 'react'

const ICONS = {
  branch: (
    <>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5" r="1.5" />
      <path d="M4.5 5v6M11.5 6.5c0 3-7 2-7 4.5" />
    </>
  ),
  tag: (
    <>
      <path d="M2.5 2.5h5l6 6-5 5-6-6z" />
      <circle cx="5.5" cy="5.5" r="1" />
    </>
  ),
  stash: (
    <>
      <path d="M2.5 6.5h11v6.5h-11z" />
      <path d="M4 6.5 5.5 3h5L12 6.5M6 9.5h4" />
    </>
  ),
  remote: (
    <>
      <path d="M4.5 12.5a3 3 0 0 1-.4-6 4 4 0 0 1 7.7-.7 3.3 3.3 0 0 1 .2 6.7z" />
    </>
  ),
  folder: <path d="M2 4.5V12.5h12V6H8L6.5 4.5z" />,
  file: (
    <>
      <path d="M3.5 1.5h6l3 3v10h-9z" />
      <path d="M9.5 1.5v3h3" />
    </>
  ),
  commit: (
    <>
      <circle cx="8" cy="8" r="2.5" />
      <path d="M1.5 8h4M10.5 8h4" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  minus: <path d="M3 8h10" />,
  check: <path d="m3 8.5 3.2 3L13 4.5" />,
  x: <path d="m4 4 8 8M12 4l-8 8" />,
  'chevron-right': <path d="m6 3.5 4.5 4.5L6 12.5" />,
  'chevron-down': <path d="M3.5 6 8 10.5 12.5 6" />,
  eye: (
    <>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M2.5 2.5l11 11M6.4 4A6.6 6.6 0 0 1 8 3.5c4 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.9 2.4M10.6 11.7A6.4 6.4 0 0 1 8 12.5C4 12.5 1.5 8 1.5 8a11.6 11.6 0 0 1 2.6-3" />
    </>
  ),
  pull: (
    <>
      <path d="M8 2v8.5M4.5 7.5 8 11l3.5-3.5" />
      <path d="M3 14h10" />
    </>
  ),
  push: (
    <>
      <path d="M8 14V5.5M4.5 8.5 8 5l3.5 3.5" />
      <path d="M3 2h10" />
    </>
  ),
  fetch: (
    <>
      <path d="M13 8a5 5 0 1 1-1.5-3.5" />
      <path d="M13 2.5v3h-3" />
    </>
  ),
  undo: (
    <>
      <path d="M4 6.5h6a3 3 0 0 1 0 6H6" />
      <path d="M6.5 4 4 6.5 6.5 9" />
    </>
  ),
  terminal: (
    <>
      <path d="M1.5 2.5h13v11h-13z" />
      <path d="m4 6 2.5 2L4 10M8 10.5h4" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 4 4" />
    </>
  ),
  warning: (
    <>
      <path d="M8 2 14.5 13.5h-13z" />
      <path d="M8 6.5v3.5M8 11.8v.2" />
    </>
  ),
  merge: (
    <>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="10" r="1.5" />
      <path d="M4.5 5v6M4.5 5c0 3 2 5 5.5 5" />
    </>
  ),
  'cloud-off': (
    <>
      <path d="M4.5 12.5a3 3 0 0 1-.4-6 4 4 0 0 1 7.7-.7 3.3 3.3 0 0 1 .2 6.7z" />
      <path d="m2 2 12 12" />
    </>
  ),
  github: (
    <>
      <path d="M6 13.5c-3 1-3-1.5-4.5-2M10 14.5v-2.3a2 2 0 0 0-.6-1.6c2-.2 4.1-1 4.1-4.4a3.5 3.5 0 0 0-1-2.4 3.2 3.2 0 0 0 0-2.4s-.8-.2-2.5 1a8.7 8.7 0 0 0-4.6 0C3.7 1.2 2.9 1.4 2.9 1.4a3.2 3.2 0 0 0 0 2.4 3.5 3.5 0 0 0-1 2.4c0 3.4 2.1 4.2 4.1 4.4a2 2 0 0 0-.6 1.6v2.3" />
    </>
  ),
  history: (
    <>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" />
      <path d="M2 2.5v2.5h2.5M8 5v3.5l2.5 1.5" />
    </>
  ),
  edit: (
    <>
      <path d="M10.5 2.5l3 3-8 8h-3v-3z" />
      <path d="m9 4 3 3" />
    </>
  ),
  trash: (
    <>
      <path d="M2.5 4.5h11M6 4.5V2.5h4v2M4 4.5l.7 9h6.6l.7-9" />
    </>
  ),
  copy: (
    <>
      <path d="M5.5 5.5h8v8h-8z" />
      <path d="M10.5 5.5v-3h-8v8h3" />
    </>
  ),
  external: (
    <>
      <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5" />
      <path d="M12 9.5v4H2.5V4h4" />
    </>
  ),
  lock: (
    <>
      <path d="M3.5 7.5h9v6.5h-9z" />
      <path d="M5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5" />
    </>
  ),
  submodule: (
    <>
      <path d="M1.5 3.5h13v10h-13z" />
      <path d="M5 7h6v4H5z" />
    </>
  ),
  worktree: (
    <>
      <path d="M8 14.5V8M8 8 4 4.5M8 8l4-3.5" />
      <circle cx="4" cy="3.5" r="1.5" />
      <circle cx="12" cy="3.5" r="1.5" />
      <path d="M5 14.5h6" />
    </>
  ),
  lfs: (
    <>
      <path d="M2.5 4.5h11v8h-11z" />
      <path d="M5 7v3M8 7v3M11 7v3M2.5 4.5 4 2h8l1.5 2.5" />
    </>
  ),
  gitflow: (
    <>
      <path d="M3 2v12M8 2v12M13 2v12" />
      <path d="M3 5c3 0 5 1 5 3M8 8c0 2 2 3 5 3" />
    </>
  ),
  refresh: (
    <>
      <path d="M13.5 6.5A5.5 5.5 0 0 0 3 5M2.5 9.5A5.5 5.5 0 0 0 13 11" />
      <path d="M3 2v3h3M13 14v-3h-3" />
    </>
  ),
  dots: (
    <>
      <circle cx="3.5" cy="8" r=".8" />
      <circle cx="8" cy="8" r=".8" />
      <circle cx="12.5" cy="8" r=".8" />
    </>
  ),
  star: <path d="m8 2 1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1L2 6.3l4.2-.5z" />,
  head: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="m5.5 8 2 2 3-4" />
    </>
  ),
  computer: (
    <>
      <path d="M2 3h12v8H2zM6 14h4M8 11v3" />
    </>
  ),
  home: <path d="M2.5 7.5 8 2.5l5.5 5M4 6.5v7h3v-4h2v4h3v-7" />,
  rename: <path d="M2.5 8h10M9 4.5 12.5 8 9 11.5" />,
  'chevron-left': <path d="M10 3.5 5.5 8l4.5 4.5" />,
  'chevron-up': <path d="M3.5 10 8 5.5l4.5 4.5" />,
  'arrow-up': <path d="M8 13.5v-11M3.5 7 8 2.5 12.5 7" />,
  'arrow-down': <path d="M8 2.5v11M3.5 9 8 13.5 12.5 9" />,
  sort: (
    <>
      <path d="M4.5 2.5v11M2 11l2.5 2.5L7 11" />
      <path d="M9 3h4.5M9 6.5h3.5M9 10h2.5M9 13.5h1.5" />
    </>
  ),
  list: <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.5M2.5 8h.5M2.5 12h.5" />,
  tree: (
    <>
      <path d="M2.5 2.5h4M4 2.5v9h2.5M4 7h2.5" />
      <path d="M8.5 5.5h5v3h-5zM8.5 10h5v3h-5z" />
    </>
  ),
  hunks: (
    <>
      <path d="M2.5 2.5h11v4h-11zM2.5 9.5h11v4h-11z" />
    </>
  ),
  inline: <path d="M2.5 3h11M2.5 6.3h11M2.5 9.7h11M2.5 13h11" />,
  split: (
    <>
      <path d="M2.5 2.5h11v11h-11zM8 2.5v11" />
    </>
  ),
  'file-view': (
    <>
      <path d="M3.5 1.5h6l3 3v10h-9z" />
      <path d="M5.5 7h5M5.5 9.5h5M5.5 12h3" />
    </>
  ),
  'diff-view': (
    <>
      <path d="M3.5 1.5h6l3 3v10h-9z" />
      <path d="M8 5.5v4M6 7.5h4M6 11.5h4" />
    </>
  ),
  wrap: <path d="M2.5 4h11M2.5 8h9a2 2 0 0 1 0 4H8m1.5-1.5L8 12l1.5 1.5M2.5 12H5" />,
  whitespace: <path d="M7 13.5v-11M10 13.5v-11M11.5 2.5H6.5a3 3 0 0 0 0 6H7" />,
  image: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <circle cx="6" cy="6.5" r="1.2" />
      <path d="M2.5 11.5l3.5-3.5 3 3 1.5-1.5 3 3" />
    </>
  ),
  scissors: (
    <>
      <circle cx="4" cy="4.5" r="1.8" />
      <circle cx="4" cy="11.5" r="1.8" />
      <path d="M5.5 5.5 13.5 12M5.5 10.5 13.5 4" />
    </>
  ),
  sparkle: (
    <>
      <path d="M7 2.5 8.3 6 11.8 7.3 8.3 8.6 7 12.1 5.7 8.6 2.2 7.3 5.7 6z" />
      <path d="M12.5 10.5v3M11 12h3" />
    </>
  ),
  'pull-request': (
    <>
      <circle cx="4" cy="3.5" r="1.5" />
      <circle cx="4" cy="12.5" r="1.5" />
      <circle cx="12" cy="12.5" r="1.5" />
      <path d="M4 5v6M12 11V6.5a2 2 0 0 0-2-2H7.5M9 3 7.5 4.5 9 6" />
    </>
  ),
  compare: (
    <>
      <circle cx="4" cy="3.5" r="1.5" />
      <circle cx="12" cy="12.5" r="1.5" />
      <path d="M4 5v4.5a2 2 0 0 0 2 2h2.5M7 10 8.5 11.5 7 13M12 11V6.5a2 2 0 0 0-2-2H7.5M9 3 7.5 4.5 9 6" />
    </>
  ),
  swap: <path d="M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13" />,
  layers: (
    <>
      <path d="M8 2 14 5.2 8 8.4 2 5.2z" />
      <path d="M2 8.2 8 11.4l6-3.2M2 11.2 8 14.4l6-3.2" />
    </>
  ),
  'user-plus': (
    <>
      <circle cx="6.5" cy="5.5" r="2.5" />
      <path d="M2 13.5c.6-2.4 2.3-3.7 4.5-3.7s3.9 1.3 4.5 3.7M12.5 4.5v4M10.5 6.5h4" />
    </>
  ),
  shield: <path d="M8 1.8 13 3.6v4c0 3.1-2.1 5.4-5 6.6-2.9-1.2-5-3.5-5-6.6v-4z" />
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof ICONS

export function Icon({ name, size = 14, style, className }: { name: IconName; size?: number; style?: CSSProperties; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: 'none', ...style }}
      aria-hidden
    >
      {ICONS[name]}
    </svg>
  )
}
