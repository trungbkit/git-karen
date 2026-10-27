import { describe, expect, it } from 'vitest'
import { compileRules, expandUrl, linkify, validateRule, type ProviderLinkInfo } from './issueLinks'

const github: ProviderLinkInfo = { kind: 'github', webUrl: 'https://github.com/o/r', issueUrl: 'https://github.com/o/r/issues/$1' }
const gitlab: ProviderLinkInfo = { kind: 'gitlab', webUrl: 'https://gitlab.com/g/app', issueUrl: 'https://gitlab.com/g/app/-/issues/$1' }

const links = (text: string, rules = compileRules(undefined, github)) =>
  linkify(text, rules)
    .filter((s) => s.url)
    .map((s) => [s.text, s.url])

describe('issue links', () => {
  it('links provider issue numbers by default', () => {
    expect(links('Fix crash (#12) and #7')).toEqual([
      ['#12', 'https://github.com/o/r/issues/12'],
      ['#7', 'https://github.com/o/r/issues/7']
    ])
    expect(links('GH-5 fixed')).toEqual([['GH-5', 'https://github.com/o/r/issues/5']])
    expect(links('see other/repo#3')).toEqual([['other/repo#3', 'https://github.com/other/repo/issues/3']])
  })

  it('ignores # inside words, URLs and entities', () => {
    expect(links('abc#12 http://x.io/#12 &#39; #x')).toEqual([])
  })

  it('links GitLab merge requests and issues', () => {
    const rules = compileRules(undefined, gitlab)
    expect(links('See !4 and #9, wow!5', rules)).toEqual([
      ['!4', 'https://gitlab.com/g/app/-/merge_requests/4'],
      ['#9', 'https://gitlab.com/g/app/-/issues/9']
    ])
  })

  it('applies custom rules with $0 and groups, and can turn provider links off', () => {
    const rules = compileRules(
      { providerLinks: false, rules: [{ pattern: 'JIRA-\\d+', url: 'https://jira.example.com/browse/$0' }, { pattern: 'T(\\d+)', url: 'https://t.io/task/$1' }] },
      github
    )
    expect(links('JIRA-42: fix #3 and T9', rules)).toEqual([
      ['JIRA-42', 'https://jira.example.com/browse/JIRA-42'],
      ['T9', 'https://t.io/task/9']
    ])
  })

  it('keeps the text intact and resolves overlaps to the earliest, then first rule', () => {
    const rules = compileRules({ providerLinks: true, rules: [{ pattern: '#\\d+-\\d+', url: 'https://x.io/$0' }] }, github)
    const segs = linkify('a #1-2 b', rules)
    expect(segs.map((s) => s.text).join('')).toBe('a #1-2 b')
    expect(segs.filter((s) => s.url).map((s) => s.text)).toEqual(['#1'])
    expect(linkify('', rules)).toEqual([{ text: '' }])
    expect(linkify('plain', [])).toEqual([{ text: 'plain' }])
  })

  it('validates rules and skips invalid ones', () => {
    expect(validateRule({ pattern: 'JIRA-\\d+', url: 'https://j/$0' })).toBeNull()
    expect(validateRule({ pattern: '(', url: 'https://j' })).toMatch(/Invalid pattern/)
    expect(validateRule({ pattern: 'a*', url: 'https://j' })).toMatch(/empty/)
    expect(validateRule({ pattern: 'x', url: 'javascript:alert(1)' })).toMatch(/http/)
    expect(compileRules({ providerLinks: false, rules: [{ pattern: '(', url: 'https://j' }] }, null)).toEqual([])
  })

  it('encodes substituted values', () => {
    const m = /(.+)/.exec('a b?c/d')!
    expect(expandUrl('https://x.io/q=$1', m)).toBe('https://x.io/q=a%20b%3Fc/d')
  })

  it('never produces non-http links', () => {
    const rules = compileRules({ providerLinks: false, rules: [{ pattern: 'X', url: 'https://ok/$0' }] }, null)
    rules.push({ re: /Y/g, url: '$0' })
    expect(links('X Y', rules)).toEqual([['X', 'https://ok/X']])
  })
})
