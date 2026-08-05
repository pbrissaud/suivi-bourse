import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
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
    // while the *real* scheduler runs against the *real* InfluxDB. On a Mac the
    // target has to be the container — #657 found the app can no longer run
    // natively at all (gunicorn forks, and libcurl's Curl_macos_init then dies
    // in CoreFoundation), so `docker compose -f docker-compose.dev.yaml up` is
    // the other half of this proxy.
    proxy: {
      '/api': {
        target: process.env.SB_API_URL || 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
})
