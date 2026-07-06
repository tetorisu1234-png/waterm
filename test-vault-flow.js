// マスターパスワードの有効化→再暗号化→解除の往復で、平文パスワードが保たれることを検証。
// main.js の encryptDefault/encryptSecret/decryptSecret と同じ挙動を最小再現する。
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const vault = require('./src/vault');

let masterKey = null;
// safeStorage が無い環境を想定して b64 経路を既定にする（enc: も同じ往復性なので代表でb64）。
function encryptDefault(plain) { return plain ? 'b64:' + Buffer.from(plain, 'utf8').toString('base64') : ''; }
function encryptSecret(plain) {
  if (!plain) return '';
  if (masterKey) { try { return 'mpw:' + vault.encrypt(plain, masterKey); } catch (_) {} }
  return encryptDefault(plain);
}
function decryptSecret(s) {
  if (!s) return '';
  try {
    if (s.startsWith('mpw:')) { if (!masterKey) return ''; return vault.decrypt(s.slice(4), masterKey); }
    if (s.startsWith('b64:')) return Buffer.from(s.slice(4), 'base64').toString('utf8');
  } catch (_) {}
  return '';
}
function reencrypt(list, toDefault) {
  const enc = toDefault ? encryptDefault : encryptSecret;
  return list.map((s) => { if (!s) return s; const p = decryptSecret(s); return p ? enc(p) : s; });
}

let pass = 0, total = 0;
function check(n, f) { total++; try { f(); pass++; console.log('PASS ' + n); } catch (e) { console.log('FAIL ' + n + ' : ' + e.message); } }

// 既存の保存済み秘密（既定方式）
const secrets = ['cisco', 'パスワード🔑', '', 'admin123'];
let stored = secrets.map(encryptDefault);

check('初期状態は既定方式で復号できる', () => {
  stored.forEach((s, i) => assert.equal(decryptSecret(s), secrets[i]));
});

// --- マスターパスワード有効化 ---
const salt = crypto.randomBytes(16);
masterKey = vault.deriveKey('master-pw', salt);
stored = reencrypt(stored, false); // mpw へ

check('有効化後は mpw で保存されている', () => {
  assert.ok(stored[0].startsWith('mpw:'));
  assert.equal(stored[2], ''); // 空はそのまま
});
check('解錠中は正しく復号できる', () => {
  stored.forEach((s, i) => assert.equal(decryptSecret(s), secrets[i]));
});
check('施錠(ロック)すると mpw は復号できない', () => {
  const saved = masterKey; masterKey = null;
  assert.equal(decryptSecret(stored[0]), '');
  masterKey = saved;
});
check('誤ったマスター鍵では復号できない', () => {
  const saved = masterKey; masterKey = vault.deriveKey('wrong', salt);
  assert.equal(decryptSecret(stored[0]), ''); // GCM失敗→''
  masterKey = saved;
});

// --- 解除（既定方式へ戻す）---
stored = reencrypt(stored, true);
masterKey = null;
check('解除後は既定方式で復号でき、平文が保たれる', () => {
  stored.forEach((s, i) => { if (secrets[i]) assert.ok(stored[i].startsWith('b64:')); assert.equal(decryptSecret(stored[i]), secrets[i]); });
});

console.log('\n' + pass + '/' + total + ' 合格');
process.exit(pass === total ? 0 : 1);
