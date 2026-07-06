'use strict';
// OpenSSH の ~/.ssh/config を WaTerm のセッション候補に変換する純粋関数。
// main.js から切り出してテスト可能にした（test-sshconfig.js）。
const os = require('os');

// Host ごとに HostName/User/Port/IdentityFile/ProxyJump を拾う。
// ワイルドカード(Host *)や ? を含む名前は個別ホストでないので除外する。
function parseSshConfig(text) {
  const out = [];
  let cur = null;
  const flush = () => { if (cur && cur.name && !cur.name.includes('*') && !cur.name.includes('?')) out.push(cur); cur = null; };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+)\s+(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'host') {
      flush();
      const first = val.split(/\s+/)[0]; // 複数パターンは先頭を名前に
      cur = { name: first, protocol: 'ssh', host: first, port: 22, username: '', authType: 'password' };
    } else if (cur) {
      if (key === 'hostname') cur.host = val;
      else if (key === 'user') cur.username = val;
      else if (key === 'port') cur.port = Number(val) || 22;
      else if (key === 'identityfile') { cur.authType = 'key'; cur.keyPath = val.replace(/^~(?=[/\\])/, os.homedir()); }
      else if (key === 'proxyjump') cur._proxyJump = val; // 参考情報（踏み台は取り込み後に手動設定）
    }
  }
  flush();
  return out;
}

module.exports = { parseSshConfig };
