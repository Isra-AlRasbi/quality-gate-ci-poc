import { defineConfig } from 'vitest/config'

/**
 * Unit tests run in `node`, not `jsdom`.
 *
 * Deliberate: no DOM emulation means fewer moving parts, faster runs and no
 * environment drift between machines. If E2E/browser validation is added later
 * it belongs in a scheduled/architecture-dependent job, not here — see
 * docs/extending-the-gate.md.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    restoreMocks: true,
    // Deterministic by default; a watch-mode developer can still opt in.
    sequence: { shuffle: false },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/vite-env.d.ts'],
      // Baseline thresholds. Raising these is a policy decision, not a
      // technical necessity — see "Assumptions" in the README.
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
})
