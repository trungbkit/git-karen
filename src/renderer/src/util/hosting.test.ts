import { describe, expect, it } from 'vitest'
import { humanizeBranch, newPullRequestUrl, parseReviewers, prefillPullRequest } from './hosting'

describe('hosting helpers', () => {
  it('builds new pull request URLs per provider', () => {
    expect(newPullRequestUrl({ kind: 'github', webUrl: 'https://github.com/o/r/' }, { base: 'main', head: 'feat/x', title: 'T a', body: 'b&c' })).toBe(
      'https://github.com/o/r/compare/main...feat/x?expand=1&title=T%20a&body=b%26c'
    )
    expect(newPullRequestUrl({ kind: 'github', webUrl: 'https://github.com/o/r' }, { base: 'main', head: 'x#1', headOwner: 'me' })).toBe(
      'https://github.com/o/r/compare/main...me:x%231?expand=1'
    )
    expect(newPullRequestUrl({ kind: 'gitlab', webUrl: 'https://gitlab.com/g/app' }, { base: 'main', head: 'f', title: 'T' })).toBe(
      'https://gitlab.com/g/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=f&merge_request%5Btarget_branch%5D=main&merge_request%5Btitle%5D=T'
    )
    expect(newPullRequestUrl({ kind: 'bitbucket', webUrl: 'https://bitbucket.org/t/a' }, { base: 'main', head: 'f' })).toBe('https://bitbucket.org/t/a/pull-requests/new?source=f&dest=main')
    expect(newPullRequestUrl({ kind: 'azure', webUrl: 'https://dev.azure.com/o/p/_git/r' }, { base: 'main', head: 'f' })).toBe(
      'https://dev.azure.com/o/p/_git/r/pullrequestcreate?sourceRef=f&targetRef=main'
    )
    const long = newPullRequestUrl({ kind: 'github', webUrl: 'https://github.com/o/r' }, { base: 'm', head: 'f', body: 'x'.repeat(10000) })
    expect(long.length).toBeLessThan(4200)
  })

  it('humanizes branch names', () => {
    expect(humanizeBranch('feature/add-login_page')).toBe('Add login page')
    expect(humanizeBranch('fix/JIRA-12-crash-on-start')).toBe('JIRA-12 crash on start')
    expect(humanizeBranch('JIRA-12')).toBe('JIRA-12')
    expect(humanizeBranch('main')).toBe('Main')
  })

  it('prefills from commits and the template', () => {
    expect(prefillPullRequest('feat/x', ['Add x'], 'Because y.\n', null)).toEqual({ title: 'Add x', body: 'Because y.' })
    expect(prefillPullRequest('feat/add-x', ['A', 'B'], null, '## Checklist')).toEqual({ title: 'Add x', body: '- A\n- B\n\n## Checklist' })
    expect(prefillPullRequest('feat/add-x', [], null, null)).toEqual({ title: 'Add x', body: '' })
  })

  it('parses reviewer lists', () => {
    expect(parseReviewers(' alice, @bob\nacme/core alice ')).toEqual(['alice', 'bob', 'acme/core'])
    expect(parseReviewers('')).toEqual([])
  })
})
