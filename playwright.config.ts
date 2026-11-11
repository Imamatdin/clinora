import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'tests/browser',workers:1,timeout:60000,fullyParallel:false,
  reporter:[['list']],use:{browserName:'chromium',trace:'off',screenshot:'off'},
  outputDir:'work/browser-results'
});
