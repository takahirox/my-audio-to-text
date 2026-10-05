import { defineConfig } from '@playwright/test';
const publishedURL = process.env.ASR_BASE_URL;
export default defineConfig({
  testDir: './tests/browser',
  timeout: 30000,
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  use: { baseURL: publishedURL || 'http://127.0.0.1:8000', headless: true },
  webServer: publishedURL ? undefined : {
    command: process.env.ASR_BENCHMARK ? 'python3 scripts/serve-reazon-benchmark.py' : 'npm run serve',
    url: 'http://127.0.0.1:8000', reuseExistingServer: false,
  },
});
