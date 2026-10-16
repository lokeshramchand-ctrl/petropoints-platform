import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // swc emits decorator metadata, which NestJS dependency injection needs (esbuild does not).
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 90_000 },
});
