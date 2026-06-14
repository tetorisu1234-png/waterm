'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const RES = 'E:\\WaTerm\\ap-res.txt';
try { fs.unlinkSync(RES); } catch (_) {}
const LOG = (...a) => fs.appendFileSync(RES, a.join(' ') + '\n');

const MODP = JSON.parse(fs.readFileSync(path.join(__dirname, 'src', 'modp-primes.json'), 'utf8'));
const _origGroup = crypto.createDiffieHellmanGroup;
crypto.createDiffieHellmanGroup = function (name) {
  try { return _origGroup.call(crypto, name); }
  catch (e) {
    const g = MODP[name];
    if (g) return crypto.createDiffieHellman(Buffer.from(g.prime, 'hex'), Buffer.from(g.gen, 'hex'));
    throw e;
  }
};

const { Client } = require('ssh2');
const c = new Client();
c.on('ready', () => {
  LOG('AP READY (patched)');
  c.shell({ term: 'xterm', cols: 80, rows: 24 }, (err, s) => {
    if (err) { LOG('shell err', err.message); c.end(); return; }
    let o = '';
    s.on('data', (d) => { o += d.toString(); });
    setTimeout(() => { LOG('prompt:', JSON.stringify(o.replace(/\s+/g, ' ').slice(-70))); c.end(); process.exit(0); }, 1500);
  });
});
c.on('error', (e) => { LOG('ERROR:', e.message); process.exit(1); });
c.connect({
  host: '192.168.10.4', port: 22, username: 'admin', password: 'cisco', readyTimeout: 15000, tryKeyboard: true,
  algorithms: { kex: ['diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1'], serverHostKey: ['ssh-rsa', 'rsa-sha2-256', 'rsa-sha2-512'], cipher: ['aes128-cbc', 'aes256-cbc', 'aes128-ctr', '3des-cbc'], hmac: ['hmac-sha1', 'hmac-sha2-256'] },
});
