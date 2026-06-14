'use strict';
const { Client } = require('ssh2');
const HOST = process.argv[2] || '192.168.10.4';
const PASS = process.argv[3] || 'cisco';
// あえて algorithms を指定せず、まずサーバが何を提示するかをdebugで見る
const c = new Client();
const remoteAlgos = {};
c.on('ready', () => { console.log('✔ READY'); c.end(); process.exit(0); });
c.on('error', e => { console.log('✖ ERROR:', e.message); process.exit(1); });
c.connect({
  host: HOST, port: 22, username: 'admin', password: PASS, readyTimeout: 15000, tryKeyboard: true,
  algorithms: {
    kex: ['diffie-hellman-group14-sha256','diffie-hellman-group14-sha1','diffie-hellman-group-exchange-sha1','diffie-hellman-group1-sha1'],
    serverHostKey: ['rsa-sha2-512','rsa-sha2-256','ssh-rsa','ssh-dss'],
    cipher: ['aes128-ctr','aes256-ctr','aes128-cbc','aes192-cbc','aes256-cbc','3des-cbc'],
    hmac: ['hmac-sha2-256','hmac-sha1','hmac-md5'],
  },
  debug: (m) => {
    if (m.includes('KEXINIT') || m.includes('Remote ident') || m.includes('handshake') || m.toLowerCase().includes('cipher') || m.toLowerCase().includes('kex')) {
      console.log('  [dbg]', m.replace(/^.*?DEBUG\]?\s*/,''));
    }
  },
});
