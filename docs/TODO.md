# Open work

## Not built yet
- Sparse checkout and shallow clone options.
- Built-in file editor.
- Bitbucket and Azure DevOps APIs (today they only get remote detection and web links).
- Virtualised left panel for repositories with thousands of branches.

## Needs manual testing in the app
Each feature below has unit or integration tests, but nobody has clicked through it in a running app yet.
- Credential prompts: clone a private HTTPS repository without a credential helper; push over SSH with a key that has a passphrase and is not in ssh-agent; a first SSH connection to a new host (host key dialog). On macOS and on Linux or Windows. Git commands run by the hosting integration (pull request checkout) do not use the dialog yet.
- Stopping a clone of a large repository, a fetch and a push from the toolbar; committing while a fetch hangs.
- Scrolling the graph of a repository with more than 2,000 commits to its end: pages load without the view jumping, a refresh keeps them, the footer reads "Beginning of history" at the root; clicking a branch (left panel) or a pull request whose tip is older than the loaded commits loads up to it and scrolls there; a soloed branch with few commits does not keep loading.
- The error boundaries: temporarily throw in `DiffView`, `LeftPanel` and a dialog and check the rest of the window keeps working.
- The file watcher on Linux (one inotify watch per folder that is not ignored), and the "Automatic refresh is off" toast after lowering `fs.inotify.max_user_watches`.
- AI keys in the keychain: save a key in Preferences > AI and check `ai.json` no longer holds it; upgrade from a build that kept keys in `ai.json` and check AI still works and the file loses the keys; on Linux without a Secret Service, check the "saved in a file" warning. After an update of an ad-hoc signed macOS build, see whether the keychain asks again before reading the key.
- Undo toasts for each dangerous action.
- Graph context menus: Reset the current branch to a branch, remote branch or tag (soft, mixed, hard); Copy commit sha on branches and tags; Merge, Rebase, Create worktree and Solo on a tag; Create tag on a remote branch; on a commit, Compare with the default and current branch, Merge into the current branch, and Move branch here (and its undo).
- Keyboard-only hunk staging, and the stage → commit → push flow without a mouse.
- Compare view (two commits; branch against the default branch).
- Image diff in all three modes.
- Expanded diff context, blame going back in history, and opening the editor at a line.
- GitHub and GitLab with real tokens: PR list, create PR, CI badges, PR checkout.
- GitHub through the GitHub CLI (Preferences > Integrations > Use GitHub CLI), including picking one of several gh accounts and a packaged app launched from Finder (gh on the PATH).
- GitHub pull request dialog (right-click a PR): comment, approve, request changes, merge with each method and branch deletion, and Actions job logs from the Checks tab and from a CI badge in the graph (long logs, running jobs, expired logs).
- `karen .` from a terminal and `karen://` links, both using a packaged `.app`.
- Drag and drop of files and folders, the "behind" banner after auto-fetch, branch prefix suggestions.
- Themes (Nord, Solarized, custom accent, following the system theme), compact density, skeletons, progress bars, error toasts with action buttons, focus rings, `prefers-reduced-motion`.
- Clone progress with a large repository.
- Clean up merged branches on a repository that uses squash merges: squash-merged branches turn ticked as the checks come in, protected branches never show, and deleting the checked-out branch switches to the base first. Group checkboxes and shift-click ranges, the list of commits not in the base, the base and remote choice kept per repo, and the "to clean up" badge on Local appearing after a fetch and going away once the dialog was opened. A local branch as the base (and a repository without remotes), and the `merged in #123` / `#123 closed` labels on upstream-deleted branches with a GitHub and a GitLab token.

## Measurements still to take
- Word-diff cost on a 5,000-line diff inside the app's WKWebView (so far it has only been measured in Chromium).
- Left panel scrolling on a real repository with 200+ branches.
- A screen reader pass (VoiceOver) over open repo → stage → commit → push.
- Windows and Linux builds of the `keyring` backend.
- Loading older commits on a repository with 20,000+ commits inside WKWebView: `git log`, the IPC transfer and the layout per page (the layout alone takes about 13 ms for 20,000 commits and 35 ms for 50,000 in Node). Each page reloads the log from the top; switch to `--skip` with de-duplication only if this proves slow.
