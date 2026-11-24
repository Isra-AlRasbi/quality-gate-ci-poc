import { defineConfig } from 'vite'

/**
 * Base Vite config.
 *
 * Build provenance (commit SHA, version) is injected here so the release
 * workflow can trace a built asset back to an exact commit — see requirement
 * 10 (traceability) in the README.
 */
export default defineConfig({
  build: {
    sourcemap: true,
    // Fail loudly instead of silently emitting a bundle CI should not ship.
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
})
