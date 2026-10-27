# Open work

## Not built yet
- AskPass prompt for HTTPS credentials and SSH passphrases.
- Sparse checkout and shallow clone options.
- Built-in file editor.
- Bitbucket and Azure DevOps APIs (today they only get remote detection and web links).
- Virtualised left panel for repositories with thousands of branches.

## Needs manual testing in the app
Each feature below has unit or integration tests, but nobody has clicked through it in a running app yet.
- Undo toasts for each dangerous action.
- Keyboard-only hunk staging, and the stage → commit → push flow without a mouse.
- Compare view (two commits; branch against the default branch).
- Image diff in all three modes.
- Expanded diff context, blame going back in history, and opening the editor at a line.
- GitHub and GitLab with real tokens: PR list, create PR, CI badges, PR checkout.
- `karen .` from a terminal and `karen://` links, both using a packaged `.app`.
- Drag and drop of files and folders, the "behind" banner after auto-fetch, branch prefix suggestions.
- Themes (Nord, Solarized, custom accent, following the system theme), compact density, skeletons, progress bars, error toasts with action buttons, focus rings, `prefers-reduced-motion`.
- Clone progress with a large repository.

## Measurements still to take
- Word-diff cost on a 5,000-line diff inside the app's WKWebView (so far it has only been measured in Chromium).
- Left panel scrolling on a real repository with 200+ branches.
- A screen reader pass (VoiceOver) over open repo → stage → commit → push.
- Windows and Linux builds of the `keyring` backend.
