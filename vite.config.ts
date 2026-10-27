// Renderer build. `tauri dev` runs this dev server (devUrl in src-tauri/tauri.conf.json); `tauri build` bundles out/renderer.
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  build: {
    outDir: resolve(__dirname, 'out/renderer'),
    emptyOutDir: true,
    // WKWebView on macOS 13+ (see bundle.macOS.minimumSystemVersion)
    target: 'safari16'
  }
})
