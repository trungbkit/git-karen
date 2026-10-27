// Smart commit workflow: AI commit messages, and stage -> commit -> push -> pull request runs.
// Every step is decided from the repository up front (prepare), shown for review and editing, then executed (execute).
import type { FileDiff, PrTemplate, PullRequestResult, SmartStatus } from '@shared/types'
import {
  buildCommitPrompt,
  buildHumanPrDescription,
  buildHumanPrTitle,
  buildPrContext,
  buildPrDescriptionPrompt,
  buildPrTitlePrompt,
  commitDiffText,
  commitTitle,
  contextKey,
  hasPrMaterial,
  parseCommitMessage,
  PR_DESCRIPTION_MAX_TOKENS,
  resolvePlan,
  sanitizePrDescription,
  sanitizeTitle,
  type PrContext,
  type SmartIntent,
  type SmartPlan
} from './text'
import { buildSplitPrompt, groupStaging, parseSplitPlan, splitUnits, SPLIT_MAX_TOKENS, type SplitGroup, type SplitUnit } from './split'

async function recentCommits(repo: string): Promise<string> {
  const commits = await window.git.log(repo, { limit: 5, all: false }).catch(() => [])
  return commits.map((c) => `${c.sha.slice(0, 7)} ${c.summary}`).join('\n')
}

/**
 * Ask the AI for a commit message describing exactly what the commit will contain: the whole working tree when the
 * commit stages everything first, the index otherwise. Throws when there is nothing to describe or the AI fails.
 */
export async function generateCommitMessage(repo: string, includeUnstaged: boolean): Promise<string> {
  const diff = commitDiffText(await window.git.pendingDiff(repo, includeUnstaged))
  if (!diff) throw new Error('There are no changes to describe.')
  const raw = await window.ai.complete(buildCommitPrompt(diff, await recentCommits(repo)))
  const message = parseCommitMessage(raw)
  if (!message) throw new Error(`The AI returned an unusable commit message: ${raw.slice(0, 200)}`)
  return message
}

export interface PreparedPr {
  target: string
  title: string
  description: string
  /** The target branch isn't on the remote, so no PR can be opened against it */
  missing: boolean
  /** Targets with identical material share a key (and generated texts) */
  key: string
}

export interface Prepared {
  status: SmartStatus
  branch: string
  remote: string | null
  plan: SmartPlan
  commitMessage: string
  prs: PreparedPr[]
  template: PrTemplate | null
  warnings: string[]
}

/** Ask for one PR text, falling back (with a warning) when the AI fails or returns nothing usable. */
async function aiText(prompt: string, maxTokens: number | undefined, sanitize: (raw: string) => string | null, fallback: string, what: string, warnings: string[]) {
  try {
    const text = sanitize(await window.ai.complete(prompt, maxTokens))
    if (text) return text
    warnings.push(`The AI returned an unusable ${what}; using a fallback.`)
  } catch (e) {
    warnings.push(`Could not generate the ${what}: ${(e as Error).message}`)
  }
  return fallback
}

async function prTexts(c: PrContext, template: PrTemplate | null, warnings: string[]): Promise<[string, string]> {
  const title = buildHumanPrTitle(c.toBranch, c.commitMessage, c.fromBranch, c.commits)
  const description = buildHumanPrDescription(c)
  if (!hasPrMaterial(c)) {
    warnings.push(`No changes found between ${c.toBranch} and ${c.fromBranch}.`)
    return [title, description]
  }
  return Promise.all([
    aiText(buildPrTitlePrompt(c), undefined, sanitizeTitle, title, `PR title for ${c.toBranch}`, warnings),
    aiText(buildPrDescriptionPrompt(c, template), PR_DESCRIPTION_MAX_TOKENS, sanitizePrDescription, description, `PR description for ${c.toBranch}`, warnings)
  ])
}

/**
 * Fetch, decide which steps will run, and generate the commit message and the PR texts for review.
 * `progress` is called with a label for each phase.
 */
export async function prepare(repo: string, intent: SmartIntent, targets: string[], progress: (label: string) => void): Promise<Prepared> {
  const warnings: string[] = []
  progress('Reading repository state')
  let status = await window.git.smartStatus(repo)
  const branch = status.branch
  if (!branch) throw new Error('HEAD is detached. Check out a branch first.')
  if (!status.hasCommits && intent.pr) warnings.push('This branch has no commits yet.')

  // the remote must be current before deciding whether a push is needed or a PR would have commits behind it
  if (status.remote && (intent.push || intent.pr)) {
    progress(`Fetching ${status.remote}`)
    try {
      await window.git.fetch(repo, status.remote, true)
      status = await window.git.smartStatus(repo)
    } catch (e) {
      warnings.push(`Could not fetch ${status.remote}; remote branches may be stale. ${(e as Error).message}`)
    }
  }

  const plan = resolvePlan(intent, status)
  const prepared: Prepared = { status, branch, remote: status.remote, plan, commitMessage: '', prs: [], template: null, warnings }
  if (!Object.values(plan.run).some(Boolean)) return prepared

  let pending = { diff: '', untracked: [] as string[] }
  if (plan.run.commit) {
    progress('Writing the commit message')
    const raw = await window.git.pendingDiff(repo, plan.run.stage)
    const diff = commitDiffText(raw)
    if (!diff) {
      // the plan only commits with staged or stageable content, so this means the changes can't be read as a diff
      plan.run.stage = plan.run.commit = false
      plan.reasons.stage ??= 'no readable diff'
      plan.reasons.commit ??= 'no readable diff'
    } else {
      pending = { diff: raw.diff, untracked: plan.run.stage ? raw.untracked : [] }
      try {
        const message = parseCommitMessage(await window.ai.complete(buildCommitPrompt(diff, await recentCommits(repo))))
        if (message) prepared.commitMessage = message
        else warnings.push('The AI returned an unusable commit message; write one below.')
      } catch (e) {
        warnings.push(`Could not generate the commit message: ${(e as Error).message}`)
      }
    }
  }

  if (plan.run.pr && status.remote) {
    progress('Writing pull request titles and descriptions')
    const remote = status.remote
    prepared.template = await window.git.prTemplate(repo).catch(() => null)
    // only work this run pushes reaches the PR; without a push it can describe nothing but what the remote has
    const pushed = plan.run.push
    const commitMessage = pushed && plan.run.commit ? prepared.commitMessage || null : null
    const contexts = await Promise.all(
      targets.map(async (target) => {
        const comparison = await window.git.compareBranch(repo, branch, target, remote)
        if (!comparison.targetExists) warnings.push(`${remote}/${target} does not exist; no PR can be opened against it.`)
        const context = buildPrContext(branch, target, comparison, {
          diff: pushed ? pending.diff : '',
          commitMessage,
          untracked: pushed ? pending.untracked : []
        })
        return { target, context, missing: !comparison.targetExists }
      })
    )
    // targets resolving to identical material (release branches at the same commit) share one pair of AI calls
    const texts = new Map<string, Promise<[string, string]>>()
    for (const { context } of contexts) {
      const key = contextKey(context)
      if (!texts.has(key)) texts.set(key, prTexts(context, prepared.template, warnings))
    }
    for (const { target, context, missing } of contexts) {
      const key = contextKey(context)
      const [title, description] = await texts.get(key)!
      prepared.prs.push({ target, title, description, missing, key })
    }
  }
  return prepared
}

export type StepState = 'running' | 'done' | 'skipped' | 'failed'

export interface StepUpdate {
  id: string
  label: string
  state: StepState
  detail?: string
  url?: string
}

export interface ExecuteOptions {
  commitMessage: string
  prs: { target: string; title: string; description: string }[]
  /** After the PRs, merge locally into targets that got one and aren't protected */
  mergeLocal: boolean
  protectedBranches: string[]
}

export interface ExecuteResult {
  prs: (PullRequestResult & { target: string })[]
  merged: string[]
}

/**
 * Run the prepared steps in order. Stage, commit and push stop the run when they fail; each PR and local merge
 * reports on its own.
 */
export async function execute(repo: string, p: Prepared, opts: ExecuteOptions, report: (u: StepUpdate) => void): Promise<ExecuteResult> {
  const step = async <T>(id: string, label: string, fn: () => Promise<T>): Promise<T> => {
    report({ id, label, state: 'running' })
    try {
      const value = await fn()
      report({ id, label, state: 'done' })
      return value
    } catch (e) {
      report({ id, label, state: 'failed', detail: (e as Error).message })
      throw e
    }
  }
  const result: ExecuteResult = { prs: [], merged: [] }
  const { branch, remote } = p

  if (p.plan.run.stage) await step('stage', 'Stage all changes', () => window.git.stageAll(repo))
  if (p.plan.run.commit) await step('commit', `Commit “${commitTitle(opts.commitMessage)}”`, () => window.git.commit(repo, opts.commitMessage))
  if (p.plan.run.push && remote) await step('push', `Push to ${remote}/${branch}`, () => window.git.push(repo, { remote, branch }))

  if (p.plan.run.pr && remote) {
    for (const pr of opts.prs) {
      const id = `pr:${pr.target}`
      const label = `Pull request ${branch} → ${pr.target}`
      report({ id, label, state: 'running' })
      let r: PullRequestResult
      try {
        r = await window.git.createPullRequest(repo, remote, branch, pr.target, pr.title.trim(), pr.description.trim())
      } catch (e) {
        r = { status: 'skipped', message: (e as Error).message }
      }
      result.prs.push({ ...r, target: pr.target })
      const detail = r.status === 'exists' ? 'Already open' : r.message
      report({ id, label, state: r.status === 'skipped' ? 'skipped' : 'done', detail, url: r.url })
    }

    if (opts.mergeLocal) {
      const mergeable = result.prs.filter((r) => r.status !== 'skipped' && !opts.protectedBranches.includes(r.target)).map((r) => r.target)
      for (const target of mergeable) {
        try {
          await step(`merge:${target}`, `Merge ${branch} into ${target} locally`, async () => {
            await window.git.checkout(repo, target)
            try {
              await window.git.pull(repo, 'ff')
              await window.git.merge(repo, branch)
              await window.git.push(repo)
            } finally {
              await window.git.checkout(repo, branch).catch(() => undefined)
            }
          })
          result.merged.push(target)
        } catch {
          // reported by step(); the other targets still get their merge
        }
      }
    }
  }
  return result
}

// ---------------------------------------------------------------------------------------------
// Split commit: the AI groups all uncommitted changes into several commits, made one after another

export interface SplitProposal {
  units: SplitUnit[]
  /** Changes against HEAD the units come from */
  diffs: FileDiff[]
  groups: SplitGroup[]
  /** Units the AI left out */
  unassigned: string[]
  warnings: string[]
}

/** Read every change (staged, unstaged and untracked) and ask the AI how to group it into commits. */
export async function proposeSplit(repo: string, progress: (label: string) => void): Promise<SplitProposal> {
  progress('Reading changes')
  const [diffs, status] = await Promise.all([window.git.headDiff(repo), window.git.status(repo)])
  const untracked = status.unstaged.filter((f) => f.status === 'untracked').map((f) => f.path)
  const units = splitUnits(diffs, untracked)
  if (units.length === 0) throw new Error('There are no changes to split.')
  if (units.length === 1) throw new Error('There is only one change; commit it as it is.')
  progress('Grouping changes with AI')
  const raw = await window.ai.complete(buildSplitPrompt(units, await recentCommits(repo)), SPLIT_MAX_TOKENS)
  const plan = parseSplitPlan(raw, units.map((u) => u.id))
  if (plan.groups.length === 0) throw new Error(`The AI proposed no usable commits. ${plan.problems.join(' ')}`.trim())
  return { units, diffs, ...plan, warnings: plan.problems }
}

/**
 * Commit the groups in order: the index is reset to HEAD first (every change stays in the work tree), then each
 * group is staged and committed. Stops at the first failure; changes of later groups are left uncommitted.
 * `opts` applies to every commit. Returns the number of commits made.
 */
export async function commitSplit(
  repo: string,
  proposal: SplitProposal,
  groups: SplitGroup[],
  opts: { noVerify?: boolean },
  report: (u: StepUpdate) => void
): Promise<number> {
  const step = async (id: string, label: string, fn: () => Promise<unknown>) => {
    report({ id, label, state: 'running' })
    try {
      await fn()
      report({ id, label, state: 'done' })
    } catch (e) {
      report({ id, label, state: 'failed', detail: (e as Error).message })
      throw e
    }
  }
  await step('reset', 'Unstage everything', () => window.git.unstageAll(repo))
  let made = 0
  for (const [i, g] of groups.entries()) {
    const { paths, patches } = groupStaging(proposal.units, proposal.diffs, g.units)
    await step(`commit:${i}`, `Commit “${commitTitle(g.message)}”`, async () => {
      if (paths.length) await window.git.stage(repo, paths)
      for (const patch of patches) await window.git.applyPatch(repo, patch, { cached: true, reverse: false })
      await window.git.commit(repo, g.message, { noVerify: opts.noVerify })
    })
    made++
  }
  return made
}
