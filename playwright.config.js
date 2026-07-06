// Electron E2E 用の最小構成。ブラウザは使わず、_electron でアプリ本体を起動する。
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './e2e',
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
});
