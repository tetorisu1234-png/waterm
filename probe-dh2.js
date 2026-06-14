'use strict';
const crypto = require('crypto');
const fs = require('fs');
const out = [];
const log = (...a) => out.push(a.join(' '));
const MODP2 = Buffer.from(
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74' +
  '020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437' +
  '4FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
  'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE65381FFFFFFFFFFFFFFFF', 'hex');
log('openssl:', process.versions.openssl);
try { const g = crypto.createDiffieHellman(MODP2, Buffer.from([2])); const g2 = crypto.createDiffieHellman(MODP2, Buffer.from([2]));
  const ak = g.generateKeys(); const bk = g2.generateKeys();
  const s1 = g.computeSecret(bk), s2 = g2.computeSecret(ak);
  log('createDiffieHellman(explicit MODP2):', 'OK match=' + s1.equals(s2) + ' pubLen=' + ak.length);
} catch (e) { log('createDiffieHellman(explicit MODP2): FAIL', e.message); }
try { crypto.getDiffieHellman('modp2').generateKeys(); log('getDiffieHellman(modp2): OK'); } catch (e) { log('getDiffieHellman(modp2): FAIL', e.message); }
const ciphers = crypto.getCiphers();
log('des-ede3-cbc:', ciphers.includes('des-ede3-cbc'), 'aes-128-cbc:', ciphers.includes('aes-128-cbc'));
// createCipheriv で実際にaes-128-cbc/des-ede3-cbc が使えるか
for (const [name, kl, il] of [['aes-128-cbc',16,16],['des-ede3-cbc',24,8]]) {
  try { crypto.createCipheriv(name, Buffer.alloc(kl), Buffer.alloc(il)); log('cipheriv', name, 'OK'); }
  catch (e) { log('cipheriv', name, 'FAIL', e.message); }
}
fs.writeFileSync('E:\\WaTerm\\probe-result.txt', out.join('\n') + '\n');
