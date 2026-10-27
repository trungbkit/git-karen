# Architecture

Karen is a local-first desktop Git client. It talks to the system `git` and, optionally, to Git hosts and AI providers using the user's own tokens. It has no account, cloud sync, team features, licensing or telemetry.

## Scope
**In scope:** commit graph, branches/tags/stashes/submodules/worktrees/Gitflow/LFS, staging by file, hunk and line, commit (templates, signing, amend), diff (split, word, image), three-way merge tool, interactive rebase, fetch/pull/push, file history and blame, undo of the last git action, command palette and keyboard shortcuts, embedded terminal, hosting integrations (PRs, CI status, issues) and AI commit messages through personal tokens.

**Out of scope:** accounts, cloud workspaces, shared patches, team features, licence or trial gating, telemetry, and an auto-updater.

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
| Secrets | OS keychain via the `keyring` crate | No tokens in config files |

## Conventions
- New git commands live in `src-tauri/src/git/`. Declare them in `src/shared/commands.ts` and `src/shared/types.ts`, and expose them in `src/renderer/src/platform/bridge.ts`.
- User actions go through `src/renderer/src/actions/` and `keybindings.ts`, so the menu, command palette and shortcuts share one implementation.
- New preferences go in `PreferencesModal.tsx` and the `prefs` state in `state/store.ts`.
- Pure logic (layout, parsers, text) gets vitest tests; Rust parsers get `cargo test`. Git operations get integration tests against real temporary repositories.
