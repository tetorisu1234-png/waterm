// WaTerm 起動スモーク: dev版 Electron を Playwright で立ち上げ、
// メインウィンドウの基本UI（サイドバーの各ボタン）が存在することを確認する。
// 手動 computer-use 検証に頼っていた「起動して壊れていない」を自動化する第一歩。
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');

test('起動してメインUIが表示される', async () => {
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    // この環境のGPUサンドボックス回避（perfMode既定と揃える）。CIでは無害。
    env: { ...process.env },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  // タイトル/主要ボタンの存在チェック（DOM id は index.html と対応）
  await expect(win.locator('#btnNew')).toBeVisible();
  await expect(win.locator('#btnImport')).toBeVisible();
  await expect(win.locator('#btnImportSsh')).toHaveCount(1);   // ~/.ssh 取り込み
  await expect(win.locator('#btnVault')).toHaveCount(1);       // マスターパスワード
  await expect(win.locator('#btnShell')).toHaveCount(1);       // ローカルシェル

  await app.close();
});

test('ローカルシェルタブが開ける', async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env } });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.click('#btnShell');
  // タブ要素が1つ増えることを確認（.tab が生成される）
  await expect(win.locator('.tab')).toHaveCount(1, { timeout: 15000 });
  await app.close();
});
