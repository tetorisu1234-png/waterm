// src/sshconfig.js の parseSshConfig 単体テスト。
'use strict';
const assert = require('assert');
const { parseSshConfig } = require('./src/sshconfig');

let pass = 0, total = 0;
function check(n, f) { total++; try { f(); pass++; console.log('PASS ' + n); } catch (e) { console.log('FAIL ' + n + ' : ' + e.message); } }

const cfg = [
  'Host *', '  ServerAliveInterval 60',
  '# コメント行', '',
  'Host web1', '  HostName 10.0.0.5', '  User deploy', '  Port 2222', '  IdentityFile ~/.ssh/id_ed25519',
  'Host jump gw', '  HostName bastion.example.com', '  User admin', '  ProxyJump web1',
  'Host only?name', '  HostName skip.me',
].join('\n');
const r = parseSshConfig(cfg);

check('ワイルドカード/?を含む Host は除外', () => { assert.ok(!r.some((s) => s.name.includes('*') || s.name.includes('?'))); });
check('件数は2（web1, jump）', () => { assert.equal(r.length, 2); });
check('web1 の各フィールド', () => {
  const w = r.find((s) => s.name === 'web1');
  assert.equal(w.host, '10.0.0.5'); assert.equal(w.username, 'deploy'); assert.equal(w.port, 2222);
  assert.equal(w.authType, 'key'); assert.ok(w.keyPath && !w.keyPath.startsWith('~'));
});
check('複数パターン Host は先頭名', () => { const j = r.find((s) => s.name === 'jump'); assert.ok(j); assert.equal(j.host, 'bastion.example.com'); assert.equal(j._proxyJump, 'web1'); });
check('空/未指定でも落ちない', () => { assert.deepEqual(parseSshConfig(''), []); assert.deepEqual(parseSshConfig(null), []); });

console.log('\n' + pass + '/' + total + ' 合格');
process.exit(pass === total ? 0 : 1);
