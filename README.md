# Karen

A local-first desktop Git client. It has no account, cloud, team or licensing features.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for scope and design choices, and [docs/TODO.md](docs/TODO.md) for open work.

## Features

### Repositories
- Open, clone (with progress) and init repositories; several repositories open at once in tabs
- Welcome screen with recent and favourite repositories, and discovery of repositories in chosen folders
- Workspaces: named groups of repositories with branch, ahead/behind and change counts for each
- `karen [path]` command line tool, `karen://` links, and drag and drop of folders onto the window
- File watcher that refreshes the view, and auto-fetch on an interval with a "behind" banner

### Commit graph
- Virtualised commit graph with its own lane layout, in a rich (avatars) or compact style
- Optional author, date, SHA, changes and description columns, with resizable widths
- Search by message, author or SHA, plus `path:` and `content:` filters that search the history
- Hide or solo branches, and save the result as named view presets
- A WIP row for the working copy and for every other worktree with uncommitted changes
- Commit details with changed files, signature status (OpenPGP, SSH, X.509) and issue links
- Compare view: two commits, or a branch against the default branch (ahead/behind and changed files)

### Staging and committing
- Stage, unstage and discard by file, hunk or line, with the keyboard or the mouse
- Commit with templates, amend, sign-off, signing (and a signing test), and skipping hooks
- Co-authored-by picker from recent authors, commit message history, and an optional Conventional Commits type/scope picker and lint
- Push after commit, and `.gitignore` entries from the file list

### Diffs and review
- Unified and split diffs with word-level changes, syntax highlighting, whitespace toggle and expandable context
- Image diffs in three modes
- File history that follows renames, and blame that follows moved and copied lines and steps back through history
- Open a file in your external editor at a given line

### Branches, tags and history
- Create, rename, delete, check out and set upstream for branches; check out remote branches as tracking branches
- Annotated and lightweight tags, pushed to or deleted from remotes
- Merge (fast-forward only, no fast-forward, squash), rebase, cherry-pick, revert and reset (soft, mixed, hard)
- Interactive rebase: pick, reword, squash, fixup, drop and edit
- Continue, skip or abort a merge, rebase, cherry-pick or revert in progress
- Three-way merge tool with its own diff3, or take "ours"/"theirs" for whole files

### Remotes and hosting
- Fetch (with prune), pull (merge, fast-forward only, rebase) and push (force, set upstream), with progress
- Add, edit and remove remotes
- GitHub and GitLab (including self-hosted) with your own token: pull request list, PR checkout, PR creation and CI status badges
- Bitbucket and Azure DevOps remotes are detected and get web links
- Tokens are kept in the OS keychain and never reach the UI

### Stashes, submodules, worktrees, Gitflow and LFS
- Stash (optionally with untracked files), apply, pop and drop
- Add and update submodules
- Add, remove, lock and prune worktrees, with a panel showing each worktree's changes
- Gitflow: init, then start and finish feature, release and hotfix branches (built in, no git-flow install needed)
- Git LFS: track patterns, and fetch, pull, push, prune and checkout

### Undo and recovery
- An Undo toast after destructive actions (discard, amend, pull, reset, branch delete, stash pop and drop, force push and more)
- Previews of what an action would lose: discarded lines, unmerged or orphaned commits
- Reflog view of HEAD to get back to any earlier state

### AI (optional, with your own key)
- Commit messages and pull request titles and descriptions from Anthropic (Claude), OpenAI or Gemini
- Smart commit: stage → commit → push → open a pull request in one flow, against configurable target branches
- Split the working-tree changes into several commits grouped by the AI
- Resolve merge conflicts with AI: it merges both sides of every conflict in a file, explains each choice, and fills the output for you to review before saving
- Summarize selected commits: what they change taken together, grouped by area, with anything worth a closer look (multi-select panel or the commit context menu)
- Review pull requests with AI from the Pull requests list: the PR is fetched without checking it out, diffed against its base like the provider does, and reviewed with findings by severity and a verdict
- Quick setup right where AI is needed (smart commit, split, Preferences): paste a key, the provider is recognised from it, and it is checked with a tiny request before it is saved
- Keys stay in the backend; environment variables such as `ANTHROPIC_API_KEY` are picked up as well

### Interface
- Command palette, fuzzy finder, and keyboard shortcuts for most actions (with a shortcut reference)
- Built-in terminal, or your external terminal
- Dark, light, Nord and Solarized themes, following the system theme, with a custom accent colour and compact density
- First-run guide on the welcome screen

## Requirements
- Node 22 or later
- Rust 1.80 or later (`rustup`), plus the platform prerequisites for [Tauri 2](https://tauri.app/start/prerequisites/) (on macOS, the Xcode command line tools)
- `git` 2.30 or later on `PATH` (and `git-lfs` for the LFS features)

## Development
```sh
npm install
npm run dev          # start the app (Vite hot reload for the UI, Rust rebuilt on change)
npm test             # renderer tests (vitest) and backend tests (cargo test)
npm run typecheck
npm run build        # release app bundle in src-tauri/target/release/bundle/
npm run package:mac  # macOS .app and .dmg; pass arm64, x64 or universal
```

## Releasing
Bump the version (in `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`), commit and tag in one step:
```sh
npm run bump -- 1.0.1          # or: patch | minor | major
git push origin HEAD && git push origin v1.0.1
```
Add `--push` to push the commit and tag right away, or `--no-commit` to only edit the files.
The [Release workflow](.github/workflows/release.yml) builds macOS (arm64 and x64 `.dmg`), Linux (`.deb`, `.rpm`, `.AppImage`) and Windows (`.exe`, `.msi`) installers and publishes them as a GitHub release. Running the workflow by hand from the Actions tab builds the same installers as workflow artifacts without releasing.

### macOS signing
Without a paid Apple Developer Program membership the macOS build is ad-hoc signed and not notarized, so Gatekeeper blocks it on first launch ("Karen cannot be opened" or "Karen is damaged"). After moving Karen to Applications, either:
- run `xattr -dr com.apple.quarantine /Applications/Karen.app`, or
- open Karen once, then go to System Settings → Privacy & Security and click **Open Anyway** (right-click → Open no longer works on macOS 15 and later).

Each release also carries these instructions in its notes.

To sign with a Developer ID certificate and notarize instead, add these repository secrets (Settings → Secrets and variables → Actions); the workflow uses them as soon as they exist:

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | The **Developer ID Application** certificate and its private key, exported from Keychain Access as `.p12`, base64 encoded: `base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | The password chosen when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | Optional, e.g. `Developer ID Application: Your Name (TEAMID)`; taken from the certificate when omitted |
| `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_P8` | For notarization: App Store Connect API issuer ID, key ID and the contents of the `.p8` key file |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Or notarize with an Apple ID, an [app-specific password](https://support.apple.com/102654) and the team ID |

## Layout
```
src/shared/          IPC contract (types.ts) and command ids
src-tauri/           Tauri (Rust) backend: git CLI service, parsers, file watcher, terminals (pty), app state, menu
src/renderer/        React UI: graph/, components/, diff/ (patch building, diff3), state/ (zustand)
  src/platform/      bridge.ts: window.git, window.app and window.term on top of Tauri IPC
```

## License
[MIT](LICENSE)
