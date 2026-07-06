import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'iife'],
  globalName: 'HumumentLib',
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
});
