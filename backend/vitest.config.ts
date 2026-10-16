import { defineConfig } from 'vitest/config';
import { createRequire } from 'node:module';
export default defineConfig({ resolve: { alias: { electron: createRequire(import.meta.url).resolve('electron') } }, test: { include: ['tests/**/*.test.ts'], environment: 'node' } });
