import { defineConfig } from '@playwright/test';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const baseURL = `http://${host}:3199`;
const authURL = `http://${host}:3198`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'allow',
  },
  projects: [
    { name: 'pixel-chrome', use: { browserName: 'chromium', viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true } },
    { name: 'tablette-chrome', use: { browserName: 'chromium', viewport: { width: 1024, height: 1366 }, hasTouch: true } },
    { name: 'desktop-chrome', use: { browserName: 'chromium', viewport: { width: 1920, height: 1080 } } },
    { name: 'firefox', use: { browserName: 'firefox', viewport: { width: 412, height: 915 } } },
  ],
  webServer: [{
    command: 'node dist/server/server/index.js',
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    env: {
      HOST: host, PORT: '3199', DATABASE_PATH: ':memory:',
      OPENAI_API_KEY: '', PUBLIC_ORIGIN: baseURL,
    },
  }, {
    // Accounts enabled, with the simulated identity provider (e2e/auth.spec.ts).
    command: 'node dist/server/server/index.js',
    url: `${authURL}/api/health`,
    reuseExistingServer: false,
    env: {
      HOST: host, PORT: '3198', DATABASE_PATH: ':memory:', NODE_ENV: 'test',
      AUTH_ENABLED: 'true', AUTH_TEST_PROVIDER: 'true', OPENAI_API_KEY: '', PUBLIC_ORIGIN: authURL,
    },
  }],
});
