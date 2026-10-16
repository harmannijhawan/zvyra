import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

/**
 * Vite build for the standalone iOS web bundle.
 *
 * It compiles the SAME renderer source as the desktop app (src/renderer),
 * resolved through the identical `@shared` / `@renderer` aliases, plus the
 * iOS adapter under ios-app/src. Output goes to ios-app/dist, which Capacitor
 * copies into the native iOS project as the web assets (webDir).
 */
export default defineConfig({
  root: here,
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(repoRoot, 'src/shared'),
      '@renderer': resolve(repoRoot, 'src/renderer/src')
    }
  },
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: { index: resolve(here, 'index.html') }
    }
  }
})
