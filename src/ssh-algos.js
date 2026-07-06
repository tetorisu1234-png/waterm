'use strict';
// レガシー(旧暗号)アルゴリズム一覧 — 古いCisco/AP等に接続するための互換設定。
// main.js から切り出した純粋データ。順序は「新しい/安全なものを優先、末尾に旧式」を保つ。
module.exports = {
  kex: [
    'curve25519-sha256', 'curve25519-sha256@libssh.org',
    'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
    'diffie-hellman-group-exchange-sha256',
    'diffie-hellman-group16-sha512', 'diffie-hellman-group18-sha512',
    'diffie-hellman-group14-sha256', 'diffie-hellman-group14-sha1',
    'diffie-hellman-group-exchange-sha1', 'diffie-hellman-group1-sha1',
  ],
  serverHostKey: [
    'ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
    'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa', 'ssh-dss',
  ],
  cipher: [
    'chacha20-poly1305@openssh.com',
    'aes128-gcm@openssh.com', 'aes256-gcm@openssh.com',
    'aes128-ctr', 'aes192-ctr', 'aes256-ctr',
    'aes256-cbc', 'aes192-cbc', 'aes128-cbc',
    '3des-cbc',
  ],
  hmac: [
    'hmac-sha2-256-etm@openssh.com', 'hmac-sha2-512-etm@openssh.com',
    'hmac-sha2-256', 'hmac-sha2-512', 'hmac-sha1', 'hmac-md5',
  ],
};
