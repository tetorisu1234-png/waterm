// npm version 実行時のフック。dev版 electron.exe の版情報埋め込み(stamp-electron-version.ps1)が
// 存在すれば実行する。無い環境（CI/他マシン）ではスキップして正常終了する。
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const ps1 = path.join(root, 'stamp-electron-version.ps1'); // machine固有・gitignore
if (process.platform === 'win32' && fs.existsSync(ps1)) {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { stdio: 'inherit' });
  process.exit(r.status || 0);
} else {
  console.log('stamp-electron-version.ps1 が無いのでスキップ（版情報の埋め込みはこの環境では不要）。');
}
