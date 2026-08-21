import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  /*
   * The automatic runtime, which is what Next compiles with. Vitest's esbuild
   * otherwise defaults to the classic one and every component fails at run
   * time with "React is not defined" — a difference between the test bundler
   * and the real one rather than anything wrong with the component.
   */
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    // .tsx as well: the PDF document is a component, and the test that proves
    // it renders has to be able to write the same JSX it does.
    include: ['tests/**/*.test.{ts,tsx}'],
  },
})
