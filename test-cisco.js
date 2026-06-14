'use strict';
const { Client } = require('ssh2');
const LEGACY = {
  kex: ['curve25519-sha256','ecdh-sha2-nistp256','diffie-hellman-group-exchange-sha256','diffie-hellman-group14-sha256','diffie-hellman-group14-sha1','diffie-hellman-group-exchange-sha1','diffie-hellman-group1-sha1'],
  serverHostKey: ['ssh-ed25519','ecdsa-sha2-nistp256','rsa-sha2-512','rsa-sha2-256','ssh-rsa','ssh-dss'],
  cipher: ['aes128-ctr','aes192-ctr','aes256-ctr','aes256-cbc','aes192-cbc','aes128-cbc','3des-cbc'],
  hmac: ['hmac-sha2-256','hmac-sha2-512','hmac-sha1','hmac-md5'],
};
const HOST = process.argv[2] || '192.168.10.2';
const c = new Client();
c.on('ready', () => {
  console.log('✔ 認証OK (ready) — shellを要求します...');
  c.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
    if (err) { console.log('✖ shell() 失敗:', err.message); return tryExec(); }
    console.log('✔ shell() 成功');
    let out = '';
    stream.on('data', d => { out += d.toString('utf8'); process.stdout.write(d.toString('utf8')); });
    stream.on('close', () => { console.log('\n--- shell closed ---'); c.end(); process.exit(0); });
    setTimeout(() => stream.write('\r\n'), 500);
    setTimeout(() => { stream.write('show clock\r\n'); }, 1200);
    setTimeout(() => { try { c.end(); } catch(_){}; process.exit(0); }, 4000);
  });
  function tryExec() {
    console.log('→ 代替: exec("show version | i Software") を試します...');
    c.exec('show version | i Software', (e, st) => {
      if (e) { console.log('✖ exec() も失敗:', e.message); c.end(); process.exit(1); }
      st.on('data', d => process.stdout.write('[exec] ' + d.toString()));
      st.on('close', () => { console.log('\n--- exec closed ---'); c.end(); process.exit(0); });
    });
  }
});
c.on('error', e => { console.log('✖ 接続/認証エラー:', e.level || '', e.message); process.exit(1); });
console.log('接続:', HOST, 'admin/cisco (legacy)');
c.connect({ host: HOST, port: 22, username: 'admin', password: 'cisco', readyTimeout: 15000, tryKeyboard: true, algorithms: LEGACY });
