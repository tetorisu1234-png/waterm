'use strict';
// WaTerm バックエンド実地テスト: SSH(shell+SFTP) と レガシー暗号(Cisco) を検証
const { Client } = require('ssh2');
const iconv = require('iconv-lite');

const LEGACY_ALGOS = {
  kex: ['curve25519-sha256','ecdh-sha2-nistp256','diffie-hellman-group-exchange-sha256','diffie-hellman-group14-sha256','diffie-hellman-group14-sha1','diffie-hellman-group-exchange-sha1','diffie-hellman-group1-sha1'],
  serverHostKey: ['ssh-ed25519','ecdsa-sha2-nistp256','rsa-sha2-512','rsa-sha2-256','ssh-rsa','ssh-dss'],
  cipher: ['chacha20-poly1305@openssh.com','aes128-gcm@openssh.com','aes256-gcm@openssh.com','aes128-ctr','aes192-ctr','aes256-ctr','aes256-cbc','aes192-cbc','aes128-cbc','3des-cbc'],
  hmac: ['hmac-sha2-256-etm@openssh.com','hmac-sha2-256','hmac-sha2-512','hmac-sha1','hmac-md5'],
};

function testParrot() {
  return new Promise((resolve) => {
    const c = new Client();
    let out = '';
    const t0 = Date.now();
    c.on('ready', () => {
      console.log(`[Parrot] ✔ SSH ready (${Date.now()-t0}ms)`);
      // SFTP テスト
      c.sftp((err, sftp) => {
        if (err) { console.log('[Parrot] SFTP error:', err.message); }
        else sftp.readdir('.', (e, list) => {
          if (e) console.log('[Parrot] readdir error:', e.message);
          else console.log(`[Parrot] ✔ SFTP readdir: ${list.length} 項目 (例: ${list.slice(0,5).map(x=>x.filename).join(', ')})`);
          // shell テスト
          c.shell({ term:'xterm-256color', cols:80, rows:24 }, (er, stream) => {
            if (er) { console.log('[Parrot] shell error:', er.message); c.end(); return resolve(); }
            stream.on('data', d => { out += iconv.decode(d, 'utf8'); });
            stream.on('close', () => {
              const lines = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'').split('\n').filter(Boolean);
              console.log('[Parrot] ✔ shell 出力(末尾2行):', JSON.stringify(lines.slice(-2)));
              c.end(); resolve();
            });
            stream.write('echo "日本語テスト UTF-8 OK: $(whoami)@$(hostname)"\n');
            setTimeout(() => stream.write('exit\n'), 700);
          });
        });
      });
    });
    c.on('error', (e) => { console.log('[Parrot] ✖ error:', e.message); resolve(); });
    c.connect({ host:'192.168.40.117', port:22, username:'parrot', password:'parrot', readyTimeout:15000 });
  });
}

function testCiscoLegacy() {
  return new Promise((resolve) => {
    const c = new Client();
    const t0 = Date.now();
    let negotiated = null;
    c.on('handshake', (info) => { negotiated = info; });
    c.on('ready', () => {
      console.log(`[Cisco] ✔ レガシー暗号でSSH ready (${Date.now()-t0}ms)`);
      if (negotiated) console.log(`[Cisco] ネゴ結果: kex=${negotiated.kex} hostkey=${negotiated.serverHostKey} cipher=${negotiated.cs.cipher} mac=${negotiated.cs.mac||'(aead)'}`);
      c.end(); resolve();
    });
    c.on('error', (e) => { console.log('[Cisco] ✖ error:', e.message); resolve(); });
    c.connect({ host:'192.168.10.2', port:22, username:'admin', password:'cisco', readyTimeout:15000, algorithms: LEGACY_ALGOS });
  });
}

(async () => {
  console.log('=== WaTerm バックエンドテスト ===');
  await testParrot();
  await testCiscoLegacy();
  console.log('=== 完了 ===');
  process.exit(0);
})();
