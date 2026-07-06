// vault.js の暗号往復・誤パスワード検知・改ざん検知の回帰テスト。
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const vault = require('./src/vault');

let pass = 0, total = 0;
function check(name, fn) { total++; try { fn(); pass++; console.log('PASS ' + name); } catch (e) { console.log('FAIL ' + name + ' : ' + e.message); } }

const salt = crypto.randomBytes(16);
const key = vault.deriveKey('correct horse battery staple', salt);

check('往復（ASCII）', () => { const t = 'p@ssw0rd!'; assert.equal(vault.decrypt(vault.encrypt(t, key), key), t); });
check('往復（日本語/絵文字）', () => { const t = 'パスワード🔑秘密'; assert.equal(vault.decrypt(vault.encrypt(t, key), key), t); });
check('往復（空文字）', () => { assert.equal(vault.decrypt(vault.encrypt('', key), key), ''); });
check('毎回IVが変わる（同じ平文でも暗号文が違う）', () => { assert.notEqual(vault.encrypt('x', key), vault.encrypt('x', key)); });
check('誤ったパスワードでは復号できない', () => {
  const wrong = vault.deriveKey('wrong', salt);
  const enc = vault.encrypt('secret', key);
  assert.throws(() => vault.decrypt(enc, wrong));
});
check('別ソルトの鍵では復号できない', () => {
  const key2 = vault.deriveKey('correct horse battery staple', crypto.randomBytes(16));
  assert.throws(() => vault.decrypt(vault.encrypt('secret', key), key2));
});
check('改ざん(GCMタグ)を検知する', () => {
  const enc = vault.encrypt('secret', key);
  const buf = Buffer.from(enc, 'base64'); buf[buf.length - 1] ^= 0xff;
  assert.throws(() => vault.decrypt(buf.toString('base64'), key));
});

console.log('\n' + pass + '/' + total + ' 合格');
process.exit(pass === total ? 0 : 1);
