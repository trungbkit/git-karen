// Pure helpers for the hosting integration: web URLs for opening a PR in the browser and PR text prefill.
import type { HostingKind } from '@shared/integrations'

/** Encode each path segment, keeping the slashes of branch names like feature/x. */
export function encPath(s: string): string {
  return s.split('/').map(encodeURIComponent).join('/')
}

/** Web URLs get long; providers cut them off somewhere around 8k. */
const MAX_URL_BODY = 4000

export interface NewPullRequestTarget {
  kind: HostingKind
  /** Web URL of the repository the PR is opened in */
  webUrl: string
}

/**
 * The provider's "new pull request" page with the branches (and, where supported, title and description) filled in.
 * `headOwner` is set when the head branch lives in a fork.
 */
export function newPullRequestUrl(
  target: NewPullRequestTarget,
  o: { base: string; head: string; headOwner?: string | null; title?: string; body?: string }
): string {
  const body = (o.body ?? '').slice(0, MAX_URL_BODY)
  const q = (params: [string, string | undefined][]) =>
    params
      .filter(([, v]) => v)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v!)}`)
      .join('&')
  const web = target.webUrl.replace(/\/+$/, '')
  switch (target.kind) {
    case 'github': {
      const head = o.headOwner ? `${encodeURIComponent(o.headOwner)}:${encPath(o.head)}` : encPath(o.head)
      return `${web}/compare/${encPath(o.base)}...${head}?${q([['expand', '1'], ['title', o.title], ['body', body]])}`
    }
    case 'gitlab':
      return `${web}/-/merge_requests/new?${q([
        ['merge_request[source_branch]', o.head],
        ['merge_request[target_branch]', o.base],
        ['merge_request[title]', o.title],
        ['merge_request[description]', body]
      ])}`
    case 'bitbucket':
      return `${web}/pull-requests/new?${q([['source', o.head], ['dest', o.base]])}`
    case 'azure':
      return `${web}/pullrequestcreate?${q([['sourceRef', o.head], ['targetRef', o.base]])}`
  }
}

/** "feature/JIRA-12-add_login-page" → "JIRA-12 add login page" (the prefix folder dropped, first letter capitalised). */
export function humanizeBranch(branch: string): string {
  const leaf = branch.split('/').pop() ?? branch
  const ticket = /^([A-Za-z][A-Za-z0-9]*-\d+)[-_ ]*(.*)$/.exec(leaf)
  const words = (ticket ? ticket[2] : leaf).replace(/[-_]+/g, ' ').trim()
  const text = ticket ? `${ticket[1]}${words ? ` ${words}` : ''}` : words
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : branch
}

/**
 * Title and description from the commits the PR brings: a single commit gives its subject and body; several give the
 * branch name and a bullet list. A repository PR template goes below.
 */
export function prefillPullRequest(branch: string, subjects: string[], singleBody: string | null, template: string | null): { title: string; body: string } {
  const parts: string[] = []
  let title: string
  if (subjects.length === 1) {
    title = subjects[0]
    if (singleBody?.trim()) parts.push(singleBody.trim())
  } else {
    title = humanizeBranch(branch)
    if (subjects.length > 1) parts.push(subjects.map((s) => `- ${s}`).join('\n'))
  }
  if (template?.trim()) parts.push(template.trim())
  return { title, body: parts.join('\n\n') }
}

/** "alice, @bob  acme/core" → ["alice", "bob", "acme/core"] (deduplicated). */
export function parseReviewers(text: string): string[] {
  const out: string[] = []
  for (const r of text.split(/[\s,;]+/)) {
    const name = r.trim().replace(/^@/, '')
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}
