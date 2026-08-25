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
  },
  build: {
    // Straight into the Python source tree. One path serves both worlds: Flask
    // resolves the bundle as `<parent of the web package>/static`, which is
    // `app/src/static` in a checkout and `/home/appuser/static` in the image
    // (the Dockerfile copies `./src` to the home directory). No second
    // convention, and no COPY that has to agree with a config value.
    outDir: path.resolve(import.meta.dirname, '../src/static'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // The dev loop #655 decision 2 is arguing for: hot reload on the front
    // while the *real* scheduler runs against the *real* store. On a Mac the
    // target has to be the container — #657 found the app can no longer run
    // natively at all (gunicorn forks, and libcurl's Curl_macos_init then dies
    // in CoreFoundation), so `docker build ./app` then `docker run` is the
    // other half of this proxy; point `SB_API_URL` at it if it is not on 8080.
    proxy: {
      '/api': {
        target: process.env.SB_API_URL || 'http://localhost:8080',
        changeOrigin: true,
      },
      // The one route the front reads that carries no `/api` prefix (#819): the
      // status dot reads the container's own probe. Without this entry the dev
      // server answers it with `index.html`, and the dot goes **red** against a
      // perfectly well app — the exact reading its red is reserved for.
      '/health': {
        target: process.env.SB_API_URL || 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
})
