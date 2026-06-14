'use strict';
const crypto = require('crypto');
const log = (...a) => console.log(...a);

// RFC2409 MODP Group2 (1024-bit) = SSH diffie-hellman-group1
const MODP2 = Buffer.from(
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74' +
  '020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437' +
  '4FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
  'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381FFFFFFFFFFFFFFFF', 'hex');

log('runtime openssl:', process.versions.openssl);

// 1) createDiffieHellmanGroup (ssh2が使う方法)
try { const g = crypto.createDiffieHellmanGroup('modp2'); g.generateKeys(); log('createDiffieHellmanGroup(modp2): OK'); }
catch (e) { log('createDiffieHellmanGroup(modp2): FAIL —', e.message); }
try { const g = crypto.createDiffieHellmanGroup('modp14'); g.generateKeys(); log('createDiffieHellmanGroup(modp14): OK'); }
catch (e) { log('createDiffieHellmanGroup(modp14): FAIL —', e.message); }

// 2) getDiffieHellman
try { const g = crypto.getDiffieHellman('modp2'); g.generateKeys(); log('getDiffieHellman(modp2): OK'); }
catch (e) { log('getDiffieHellman(modp2): FAIL —', e.message); }

// 3) createDiffieHellman(明示プライム) — フォールバック候補
try {
  const a = crypto.createDiffieHellman(MODP2, Buffer.from([2]));
  const b = crypto.createDiffieHellman(MODP2, Buffer.from([2]));
  const ak = a.generateKeys(); const bk = b.generateKeys();
  const s1 = a.computeSecret(bk); const s2 = b.computeSecret(ak);
  log('createDiffieHellman(explicit MODP2): OK, shared match =', s1.equals(s2));
} catch (e) { log('createDiffieHellman(explicit MODP2): FAIL —', e.message); }

// 4) 3des 等のレガシー暗号の可用性
const ciphers = crypto.getCiphers();
for (const c of ['des-ede3-cbc', 'aes-128-cbc', 'aes-256-cbc']) log('cipher', c, ':', ciphers.includes(c));
const hashes = crypto.getHashes();
for (const h of ['md5', 'sha1']) log('hash', h, ':', hashes.includes(h));
