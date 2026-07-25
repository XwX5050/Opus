import { defineConfig } from 'vite';
import { defaultExclude } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './vitest.setup.ts',
    restoreMocks: true,
    // Playwright specs live in tests/e2e and run via `npm run test:e2e`.
    // .worktrees holds development worktrees whose sources must not be tested here.
    exclude: [...defaultExclude, 'tests/e2e/**', '.worktrees/**'],
  },
});
