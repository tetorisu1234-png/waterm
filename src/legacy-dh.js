'use strict';
/*
 * レガシーDH(古い暗号)対応:
 * Electron内蔵Node(BoringSSL)は diffie-hellman-group1/14-sha1 等の名前付きMODPグループや
 * 大きい明示プライムDHを安定して扱えない(「Unknown DH group」やクラッシュ)。
 * そこで BoringSSL 実行時のみ、ssh2 が使う createDiffieHellmanGroup / createDiffieHellman を
 * 純JS(BigInt)実装のDHに差し替える。mpint整形はssh2側が行うため、整数値が正しければKEXは成立する。
 * 素のNode(OpenSSL)では何もしない(ネイティブを使用)。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// BoringSSL判定 (Electronは openssl バージョンを '0.0.0' と報告)
const isBoringSSL = !process.versions.openssl || /^0\./.test(process.versions.openssl);

if (isBoringSSL) {
  let MODP = {};
  try { MODP = JSON.parse(fs.readFileSync(path.join(__dirname, 'modp-primes.json'), 'utf8')); } catch (_) {}

  const modPow = (base, exp, mod) => {
    base %= mod;
    let r = 1n;
    while (exp > 0n) { if (exp & 1n) r = (r * base) % mod; exp >>= 1n; base = (base * base) % mod; }
    return r;
  };
  const b2i = (buf) => (buf && buf.length ? BigInt('0x' + buf.toString('hex')) : 0n);
  const i2b = (n) => { let h = n.toString(16); if (h.length & 1) h = '0' + h; return Buffer.from(h, 'hex'); };

  function makeDH(primeBuf, genBuf) {
    const p = b2i(primeBuf);
    const g = b2i(genBuf && genBuf.length ? genBuf : Buffer.from([2]));
    let x = null, pub = null;
    return {
      generateKeys() {
        if (x === null) {
          // プライムと同程度のビット長の秘密指数を生成 (範囲 [2, p-2])
          x = (b2i(crypto.randomBytes(primeBuf.length)) % (p - 3n)) + 2n;
          pub = modPow(g, x, p);
        }
        return i2b(pub);
      },
      computeSecret(otherBuf) { return i2b(modPow(b2i(otherBuf), x, p)); },
      getPublicKey() { return i2b(pub); },
      getPrime() { return Buffer.from(primeBuf); },
      getGenerator() { return Buffer.from(genBuf && genBuf.length ? genBuf : Buffer.from([2])); },
    };
  }

  const _origGroup = crypto.createDiffieHellmanGroup;
  crypto.createDiffieHellmanGroup = function (name) {
    const g = MODP[name];
    if (g) return makeDH(Buffer.from(g.prime, 'hex'), Buffer.from(g.gen, 'hex'));
    return _origGroup.call(crypto, name);
  };

  const _origCDH = crypto.createDiffieHellman;
  crypto.createDiffieHellman = function (prime, gen) {
    if (Buffer.isBuffer(prime)) {
      const gb = Buffer.isBuffer(gen) ? gen : Buffer.from([typeof gen === 'number' ? gen : 2]);
      return makeDH(prime, gb);
    }
    return _origCDH.apply(crypto, arguments);
  };

  module.exports = { patched: true, groups: Object.keys(MODP) };
} else {
  module.exports = { patched: false };
}
