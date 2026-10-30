// AI write-ups for the AI view: a summary of selected commits and a review of a pull request. Reads what git has,
// builds the prompt (./insight.ts) and asks the configured provider.
import type { PullRequest } from '@shared/integrations'
import { buildReviewPrompt, buildSummaryPrompt, cleanReport, omissionNote, REVIEW_MAX_TOKENS, SUMMARY_MAX_TOKENS, type BuiltPrompt } from './insight'

export interface Report {
  text: string
  /** What the AI did not see, when something had to be left out */
  note: string | null
}

async function ask({ prompt, omissions }: BuiltPrompt, maxTokens: number): Promise<Report> {
  const raw = await window.ai.complete(prompt, maxTokens)
  const text = cleanReport(raw)
  if (!text) throw new Error('The AI returned an empty reply. Try again.')
  return { text, note: omissionNote(omissions) }
}

/** `shas` oldest first. */
export async function summarizeCommits(repo: string, shas: string[], progress: (label: string) => void): Promise<Report> {
  progress(`Reading ${shas.length} ${shas.length === 1 ? 'commit' : 'commits'}`)
  const patches = await window.git.commitPatches(repo, shas)
  progress('Summarizing with AI')
  return ask(buildSummaryPrompt(patches), SUMMARY_MAX_TOKENS)
}

/** Fetch the PR (nothing is checked out), diff it against its base the way the provider would, and review that. */
export async function reviewPullRequest(repo: string, remote: string, pr: PullRequest, progress: (label: string) => void): Promise<Report> {
  progress(`Fetching #${pr.number}`)
  const head = await window.integrations.fetchPullRequest(repo, remote, pr.number, pr.headBranch, pr.sameRepo, pr.baseBranch)
  progress('Reading changes')
  const comparison = await window.git.compareBranch(repo, head, pr.baseBranch, remote)
  if (!comparison.targetExists) throw new Error(`${remote}/${pr.baseBranch} does not exist.`)
  if (!comparison.diff.trim()) throw new Error(`#${pr.number} has no changes that ${pr.baseBranch} doesn't already have.`)
  progress('Reviewing with AI')
  return ask(buildReviewPrompt(pr, comparison), REVIEW_MAX_TOKENS)
}
