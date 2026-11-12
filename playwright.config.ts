import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'tests/browser',workers:1,timeout:60000,fullyParallel:false,
  reporter:[['list']],use:{browserName:'chromium',trace:'off',screenshot:'only-on-failure',
    // Opt-in for machines with a preinstalled Chromium of another Playwright build; CI installs its own.
    ...(process.env.PW_CHROMIUM_PATH?{launchOptions:{executablePath:process.env.PW_CHROMIUM_PATH}}:{})},
  outputDir:'work/browser-results'
});
