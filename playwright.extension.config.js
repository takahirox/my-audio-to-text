import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/extension',
  timeout: 30000,
  workers: 1,
  use: { headless: true },
});
