import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backend = process.env.API_TARGET || 'http://127.0.0.1:3000'
const media = process.env.MEDIA_TARGET || 'http://127.0.0.1:8888'

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    proxy: {
      '/api': { target: backend, changeOrigin: true },
      '/img': { target: media, changeOrigin: true },
      '/gif': { target: media, changeOrigin: true }
    }
  },
  build: { chunkSizeWarningLimit: 1500 },
  // See test/setup.js: Node 26's built-in localStorage is unusable without a CLI flag and
  // shadows the one happy-dom installs, which kills any test that imports the store.
  test: { setupFiles: ['./test/setup.js'] }
})
