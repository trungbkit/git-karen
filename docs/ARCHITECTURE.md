# Architecture

Karen is a local-first desktop Git client. It talks to the system `git` and, optionally, to Git hosts and AI providers using the user's own tokens. It has no account, cloud sync, team features, licensing or telemetry.

## Scope
**In scope:** commit graph, branches/tags/stashes/submodules/worktrees/Gitflow/LFS, staging by file, hunk and line, commit (templates, signing, amend), diff (split, word, image), three-way merge tool, interactive rebase, fetch/pull/push, file history and blame, undo of the last git action, command palette and keyboard shortcuts, embedded terminal, hosting integrations (PRs, CI status, issues; on GitHub also review, comments, merge and Actions logs) and AI commit messages through personal tokens.

**Out of scope:** accounts, cloud workspaces, shared patches, team features, licence or trial gating and telemetry. The updater only downloads public GitHub releases; it sends nothing about the user.

## Design choices
| Area | Choice | Why |
|---|---|---|
| Shell | Tauri 2 (Rust backend, system WebView) with Vite for the UI | A small bundle and low memory use; the backend mostly shells out to git |
| Git engine | The system `git` CLI (porcelain v2, `-z`, custom `--format`) | No native module to build; covers LFS, hooks, signing and worktrees |
| IPC | One typed contract (`src/shared/types.ts`) and a `Result<T>` envelope | Errors keep git's stderr message across the bridge |
| State | zustand | Enough for this size of app |
| Graph | Own lane layout (`graph/layout.ts`), virtualised SVG rows | A pure, unit-tested function |
| Partial staging | Patches built in the renderer (`diff/patch.ts`), applied with `git apply --cached [--reverse] --recount` | The usual model for Git GUIs |
| Merge tool | Own diff3 (`diff/merge3.ts`) | No dependency |
| Interactive rebase | `GIT_SEQUENCE_EDITOR` set to a command that copies a prepared todo list into place | Lets git drive the rebase |
| HTTP (hosting, AI) | System `curl`, called from Rust; the `Authorization` header goes through curl's stdin config | No extra TLS stack, honours proxy variables, tokens never reach the webview or the command line |
| GitHub credentials | A keychain token, or per host `gh auth token` from the GitHub CLI (cached 5 min) | Reuses an existing `gh auth login`; gh only supplies the token, requests still go through curl |
| Refresh | A recursive watcher (`git/watcher.rs`) reports debounced batches (300 ms quiet, at most 2 s) with a scope: `refs` when HEAD, refs or operation state changed, `worktree` for the index and files. The renderer reloads the log only for `refs`, and runs at most one refresh per repo at a time (`state/coalesce.ts`), folding calls made meanwhile into one follow-up. Changes in what `.gitignore` excludes are dropped: a cache from `git ls-files --others --ignored --directory`, relisted when a `.gitignore` or `.git/info/exclude` changes, and `git check-ignore` for paths the cache does not know yet. macOS and Windows use one recursive watch; Linux (inotify, one watch per folder) watches each folder that is not ignored, plus `.git` and `.git/refs`. A watcher that cannot start or hits the watch limit tells the renderer once (`evt:watchFailed`) | Saving a file does not reload 2,000 commits, an older result never lands after a newer one, and a build in `target/` neither refreshes the view nor uses up inotify watches |
| Locks and cancel | Two locks per repo in `GitService`: the write lock for commands that change the index, work tree or local refs, and a network lock for fetch, push and remote tag or branch deletion. Pull, submodule update and LFS pull take the network lock and then the write lock. Every remote command registers a cancel token; `cancelOperation(repo)` stops it (SIGTERM to its process group, SIGKILL after 3 s), and the renderer shows no error for it. Automatic fetches stop after 90 s without output | A fetch hanging on the network never holds up a commit, and the user can always stop it |
| Credential prompts | The Karen executable is also the askpass program (`askpass.rs`). Remote commands get `GIT_ASKPASS`, `SSH_ASKPASS` with `SSH_ASKPASS_REQUIRE=force` (OpenSSH 8.4+ only) and a one-command token; run that way, the binary exits before any GUI code after asking the app over a Unix socket in a 0700 folder (a named pipe refusing remote clients on Windows). The renderer shows the prompt (`AskPassDialog`), every window gets it and the first answer wins | git and ssh can ask for passwords, passphrases and host keys without a terminal, and answers never touch disk, logs or the store |
| Secrets | OS keychain via the `keyring` crate | No tokens in config files |
| Updates | `tauri-plugin-updater` driven from Rust (`updater.rs`): `latest.json` on the latest GitHub release, packages signed with minisign (`requireSignedVersion`). Checks 15 s after launch and every 6 h, downloads in the background, installs on restart | Releases stay plain GitHub releases; a tampered manifest cannot install an unsigned or older build |

## Conventions
- New git commands live in `src-tauri/src/git/`. Declare them in `src/shared/commands.ts` and `src/shared/types.ts`, list them in `GIT_METHODS` (`src/shared/gitMethods.ts`) and add the arm in `GitService::call`. `platform/ipcContract.test.ts` fails when the renderer and a Rust dispatcher (`git_call`, `app_call`, `ai_call`, `integrations_call`) disagree on a method name.
- User actions go through `src/renderer/src/actions/` and `keybindings.ts`, so the menu, command palette and shortcuts share one implementation.
- New preferences go in `PreferencesModal.tsx` and the `prefs` state in `state/store.ts`.
- Pure logic (layout, parsers, text) gets vitest tests; Rust parsers get `cargo test`. Git operations get integration tests against real temporary repositories.
- A string from IPC or a hosting API that becomes a positional git argument goes through a check in `git/args.rs` (`rev_arg`, `branch_name`, `tag_name`, `remote_name`, `remote_url`, `config_key`, `path_arg`), which rejects empty values, a leading `-` and control characters; paths go after `--`.
