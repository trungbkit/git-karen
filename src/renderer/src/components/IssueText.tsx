// Commit message text with issue references linked (plan 07.5). Links open in the browser and don't select the row.
import { Fragment, useMemo, type ReactNode } from 'react'
import { useIssueRules } from '../state/hosting'
import { linkify } from '../util/issueLinks'
import '../styles/hosting.css'

export function IssueText({ repo, text, render }: { repo: string; text: string; render?: (plain: string) => ReactNode }) {
  const rules = useIssueRules(repo)
  const segments = useMemo(() => linkify(text, rules), [text, rules])
  return (
    <>
      {segments.map((s, i) =>
        s.url ? (
          <a
            key={i}
            className="issue-link"
            href={s.url}
            title={s.url}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              void window.app.openExternal(s.url!)
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {render ? render(s.text) : s.text}
          </a>
        ) : (
          <Fragment key={i}>{render ? render(s.text) : s.text}</Fragment>
        )
      )}
    </>
  )
}
