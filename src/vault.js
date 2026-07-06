'use strict';
// マスターパスワード方式の秘密保管庫。
// safeStorage(OSキーチェーン)に加え、ユーザー任意のマスターパスワード由来鍵で二重に守る。
//   鍵導出: scrypt(password, salt) → 32バイト
//   暗号化: AES-256-GCM（iv 12B + tag 16B + 暗号文）を base64 で格納
// マスター鍵はプロセスメモリ上にのみ保持し、ディスクには salt と検証トークンだけ残す。
const crypto = require('crypto');

const KDF = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

function deriveKey(password, salt) {
  return crypto.scryptSync(Buffer.from(String(password), 'utf8'), salt, KDF.keylen,
    { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: KDF.maxmem });
}

function encrypt(plain, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(String(plain), 'utf8')), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

function decrypt(b64, key) {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

module.exports = { deriveKey, encrypt, decrypt, KDF };
