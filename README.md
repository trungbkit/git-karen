# Karen

A local-first desktop Git client. It has no account, cloud, team or licensing features.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for scope and design choices, and [docs/TODO.md](docs/TODO.md) for open work.

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

## Layout
```
src/shared/          IPC contract (types.ts) and command ids
src-tauri/           Tauri (Rust) backend: git CLI service, parsers, file watcher, terminals (pty), app state, menu
src/renderer/        React UI: graph/, components/, diff/ (patch building, diff3), state/ (zustand)
  src/platform/      bridge.ts: window.git, window.app and window.term on top of Tauri IPC
```

## License
[MIT](LICENSE)
