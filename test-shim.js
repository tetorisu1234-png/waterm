'use strict';
const fs = require('fs');
const RES = 'E:\\WaTerm\\shim-res.txt';
const LOG = (...a) => fs.appendFileSync(RES, a.join(' ') + '\n');
const info = require('./src/legacy-dh');   // ssh2 より前に patch
LOG('shim patched=' + info.patched + ' groups=' + (info.groups || []).join(','));
const { Client } = require('ssh2');
const HOST = process.argv[2] || '192.168.10.4';
const c = new Client();
c.on('ready', () => {
  LOG('READY ' + HOST);
  c.shell({ term: 'xterm', cols: 80, rows: 24 }, (err, s) => {
    if (err) { LOG('shell err ' + err.message); c.end(); process.exit(0); }
    let o = '';
    s.on('data', (d) => { o += d.toString(); });
    setTimeout(() => { LOG('prompt=' + JSON.stringify(o.replace(/\s+/g, ' ').slice(-50))); c.end(); process.exit(0); }, 1800);
  });
});
c.on('error', (e) => { LOG('ERROR ' + e.message); process.exit(1); });
c.connect({
  host: HOST, port: 22, username: 'admin', password: 'cisco', readyTimeout: 15000, tryKeyboard: true,
  algorithms: { kex: ['diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1'], serverHostKey: ['ssh-rsa', 'rsa-sha2-256', 'rsa-sha2-512'], cipher: ['aes128-cbc', 'aes256-cbc', 'aes128-ctr', '3des-cbc'], hmac: ['hmac-sha1', 'hmac-sha2-256'] },
});
