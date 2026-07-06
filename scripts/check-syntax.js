// 全JSソースを node --check し、構文エラーがあれば非0で終了する。CIとpreversionで使う。
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const targets = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'release') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) targets.push(p);
  }
}
walk(path.join(root, 'src'));
for (const f of ['test-transfer.js', 'test-ttl.js', 'test-features3.js']) {
  const p = path.join(root, f);
  if (fs.existsSync(p)) targets.push(p);
}
walk(path.join(root, 'scripts'));

let bad = 0;
for (const f of targets) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { bad++; console.error('SYNTAX ERROR: ' + path.relative(root, f) + '\n' + (e.stderr || e.stdout || e.message)); }
}
console.log(`${targets.length - bad}/${targets.length} JS files OK`);
process.exit(bad ? 1 : 0);
