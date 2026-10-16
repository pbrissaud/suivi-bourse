/// <reference types="vitest/config" />
import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  // The suite runs on the same config as the app — same alias, same plugins —
  // so a test imports `@/lib/api` exactly as a component does. `jsdom` is the
  // environment because the seam is the screen; `setup.ts` is what makes the
  // run offline and configuration-free.
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // Vitest's default is 5 s per test, and it is a *default*, not a budget the
    // suite was measured against. The heaviest cases here paginate a ledger by
    // packets behind `findBy*`, and under the full run's parallel load they sat
    // just the wrong side of five seconds — passing alone, failing in the
    // suite. A timeout that fires on machine load rather than on a hung
    // assertion reports nothing; 20 s is still far below any real hang.
    testTimeout: 20_000,
  },
  build: {
    // Straight into the `api` package, which Flask resolves the bundle from
    // (`api/static`). One path serves both worlds: the checkout's editable
    // install reads it in place, and the image builds it into the `app` wheel.
    outDir: path.resolve(import.meta.dirname, '../../packages/app/src/api/static'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // The dev loop #655 decision 2 is arguing for: hot reload on the front
    // while the *real* scheduler runs against the *real* store. Point
    // `SB_API_URL` at it if it is not on 8080.
    proxy: {
      '/api': {
        target: process.env.SB_API_URL || 'http://localhost:8080',
        changeOrigin: true,
      },
      // The one route the front reads that carries no `/api` prefix (#819): the
      // header's bell reads the container's own probe. Without this
      // entry the dev server answers it with `index.html`, and the bell goes
      // **red** against a perfectly well app — the exact reading its red is
      // reserved for.
      '/health': {
        target: process.env.SB_API_URL || 'http://localhost:8080',
        changeOrigin: true,
      },
      // The PIN's gate (#1203): the front asks `/auth/status` before it draws
      // anything, and `index.html` in its place would read as an unreadable app.
      '/auth': {
        target: process.env.SB_API_URL || 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
})
