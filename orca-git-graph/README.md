# Git Graph for Orca

A right-sidebar panel for [Orca](https://github.com/stablyai/orca) that draws the commit graph of the
focused workspace's repository: branches, remotes, tags, stashes and uncommitted changes, with a
details pane for the selected commit. The lane layout is ported from the Karen Git client.

## What it does

- Lane graph of `--branches --remotes --tags HEAD` in date order. It loads 1,000 commits at a time
  and fetches more as you scroll.
- Author pictures as commit nodes, with initials until the picture arrives. Sources, as in Karen:
  GitHub noreply addresses, then Gravatar, then the GitHub account linked to the commit for
  github.com repositories (GitHub's API without a token allows 60 lookups an hour). Turn them off
  under the plugin in Orca's Settings (**Author pictures**) to show plain dots.
- Ref pills. A local branch and its remote twin share one pill; the checked-out branch comes first.
- A `// WIP` row when the working tree has changes, and a row for each stash.
- Search by message, sha, author or ref. Enter goes to the next match, Shift+Enter to the previous one.
- Details for the selected commit: author, committer, parents (click one to jump to it), refs,
  message, and changed files with line counts. Merges are diffed against their first parent.
- Refreshes when you switch workspace or branch, when HEAD, refs, the index or stashes change
  (the worker watches the repository's git dir), and when the panel comes back into view.
- Keys: ↑/↓, Home and End move the selection; Esc closes the details pane.

It only reads. It never changes the repository. The only network traffic is fetching author
pictures: a SHA-256 hash of each author's email goes to Gravatar, and for github.com repositories
commit ids go to `api.github.com`. Workspaces on SSH or remote hosts are not
supported yet.

## How it works

| Part | File | Role |
| --- | --- | --- |
| Manifest | `orca-plugin.json` | `trusted-worker`, one html panel, the `avatars` setting, `workspace:read` and `settings:own` |
| Worker | `worker/main.mjs` | Maps the panel's workspace id to its folder (`workspace.list`), answers `graph.load` and `graph.commit`, watches the git dir and posts `graph.changed` |
| Git | `worker/git.mjs` | Runs `git` and parses its output. It has no Orca imports, so it is tested with plain Node |
| Panel | `panel/index.html`, `app.js`, `style.css` | Virtualised rows, one small SVG per row for its lanes, plus the details pane |
| Avatars | `worker/avatars.mjs`, `panel/avatars.js` | Plugin frames have no network, so the worker downloads each 64px picture and answers `avatars.get` with data: URLs. The panel turns each picture into one SVG `<symbol>` the rows reuse, and caches them in localStorage (pictures for a week, misses for a day) |
| Layout | `panel/layout.js` | Lane assignment and edge paths, ported from Karen's `graph/layout.ts` and `geometry.ts` |

### Finding the focused repository

`workspace.readContext` gives the focused workspace's name, branch and terminal ids. It does not
always include `workspaceId`, and names repeat: many workspaces are called `main` on branch `main`.
`worker/resolve.mjs` matches it to a `workspace.list` row this way:

1. By `workspaceId`, when Orca includes it.
2. By name and branch, when only one row has them.
3. By terminal id through `terminal.list`. That method needs host API 1.7 (Orca 1.4.259 or newer).
4. Otherwise the panel lists the matching repositories and you pick one. The panel remembers the
   pick per terminal id, so returning to that workspace finds it again.

Panel and worker talk only through `orca.plugin.request` and `orca.plugin.on`. Each answer must stay
under Orca's 1 MiB limit, so a commit in the list carries only short fields; the full message and
file list are fetched one commit at a time.

## Develop

```sh
npm test                    # parser, layout and real-git tests (node --test)
orca plugin validate .      # manifest checks
orca plugin dev load .      # load into the running Orca; it prints an approval fingerprint
orca plugin dev load . --approve <fingerprint>
orca plugin open local.git-graph --panel graph
orca plugin logs local.git-graph
orca plugin dev request . graph.load --data '{"limit":5}'
```

You can also load it from Settings → Plugins → Development folders. Orca reloads the plugin when
files change.

Needs `git` on the PATH of the Orca process and Orca 1.4.246 or newer.
