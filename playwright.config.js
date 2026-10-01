import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  timeout: 30000,
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  use: { baseURL: 'http://127.0.0.1:8000', headless: true },
  webServer: { command: 'npm run serve', url: 'http://127.0.0.1:8000', reuseExistingServer: false },
});
