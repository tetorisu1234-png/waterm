'use strict';
const { app, BrowserWindow, ipcMain, Menu, dialog, shell, safeStorage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');
const cp = require('child_process');
const { spawn } = cp;
// 古い暗号(レガシーDH)対応: ssh2 を require する前に crypto をパッチする
const legacyDH = require('./legacy-dh');
const winembed = require('./winembed');
const transfer = require('./transfer');
const pcap = require('./pcap');
let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; } catch (_) { autoUpdater = null; }
const { Client } = require('ssh2');
const iconv = require('iconv-lite');

// ---------------------------------------------------------------------------
// データ保存先
// ---------------------------------------------------------------------------
const DATA_DIR = app.getPath('userData');
const SESS_FILE = path.join(DATA_DIR, 'waterm-sessions.json');
const SESS_BAK = path.join(DATA_DIR, 'waterm-sessions.bak');       // 直近の「中身あり」セッションの退避先
const SET_FILE = path.join(DATA_DIR, 'waterm-settings.json');
const KNOWN_FILE = path.join(DATA_DIR, 'waterm-knownhosts.json');
const SNIP_FILE = path.join(DATA_DIR, 'waterm-snippets.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
// 原子的書き込み（tmpへ書いてrename）。途中中断による破損(0バイト/欠け)を防ぐ
function writeJson(file, data) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) { return false; }
}
function sessCount(d) { return (d && Array.isArray(d.sessions)) ? d.sessions.length : 0; }
// セッション保存：空で上書きされても復元できるよう、保存前に「中身あり」の現状を .bak へ退避してから書く
function saveSessions(data) {
  try {
    const cur = readJson(SESS_FILE, null);
    if (sessCount(cur) > 0) { try { fs.copyFileSync(SESS_FILE, SESS_BAK); } catch (_) {} }
  } catch (_) {}
  return writeJson(SESS_FILE, data);
}
// セッション読込：本体が壊れて読めない時は .bak から自動復旧（壊れた本体は .corrupt へ退避）
function loadSessions() {
  let raw;
  try { raw = fs.readFileSync(SESS_FILE, 'utf8'); }
  catch (_) { return readJson(SESS_BAK, { folders: [], sessions: [] }); } // 本体無し → .bak（無ければ空）
  try {
    const d = JSON.parse(raw);
    // 中身があり .bak が未作成なら、この時点で1つ作っておく（起動直後から復元材料を確保）
    if (sessCount(d) > 0 && !fs.existsSync(SESS_BAK)) { try { fs.copyFileSync(SESS_FILE, SESS_BAK); } catch (_) {} }
    return d;
  } catch (_) {
    // 本体が破損 → .bak に中身があれば復旧
    const bak = readJson(SESS_BAK, null);
    if (sessCount(bak) > 0) {
      try { fs.copyFileSync(SESS_FILE, SESS_FILE + '.corrupt'); } catch (_) {}
      writeJson(SESS_FILE, bak);
      return bak;
    }
    return { folders: [], sessions: [] };
  }
}

// ---------------------------------------------------------------------------
// パスワード暗号化 (OSキーチェーン利用)
// ---------------------------------------------------------------------------
function encryptSecret(plain) {
  if (!plain) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(plain).toString('base64');
    }
  } catch (_) {}
  return 'b64:' + Buffer.from(plain, 'utf8').toString('base64');
}
function decryptSecret(stored) {
  if (!stored) return '';
  try {
    if (stored.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    }
    if (stored.startsWith('b64:')) {
      return Buffer.from(stored.slice(4), 'base64').toString('utf8');
    }
  } catch (_) {}
  return '';
}

// ---------------------------------------------------------------------------
// レガシー(旧暗号) アルゴリズム一覧 — 古いCisco/AP等に接続するための互換設定
// ---------------------------------------------------------------------------
const LEGACY_ALGOS = {
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

// ---------------------------------------------------------------------------
// 接続管理
// ---------------------------------------------------------------------------
/** id -> { type, client, stream, sock, sftp, enc, newline, localEcho, logStream } */
const conns = new Map();

function send(wc, channel, payload) {
  if (wc && !wc.isDestroyed()) wc.send(channel, payload);
}
// 接続の現在の描画先 webContents（ウィンドウ分離で entry.wc が張り替わる）
function wcOf(id, fallback) { const en = conns.get(id); return (en && en.wc) || fallback; }

// 通信モニタ：送受信バイトを記録し、描画先へ逐次通知する
const MON_MAX_FRAMES = 20000, MON_MAX_BYTES = 16 * 1024 * 1024;
function monitorCapture(id, dir, buf) {
  const en = conns.get(id);
  if (!en || !en.monitor || !buf || !buf.length) return;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const ts = Date.now();
  if (!en.monitorLog) { en.monitorLog = []; en.monitorBytes = 0; }
  en.monitorLog.push({ dir, ts, bytes: b });
  en.monitorBytes += b.length;
  while (en.monitorLog.length > MON_MAX_FRAMES || en.monitorBytes > MON_MAX_BYTES) {
    const old = en.monitorLog.shift(); if (!old) break; en.monitorBytes -= old.bytes.length;
  }
  send(en.wc, 'monitor:data', { id, dir, ts, len: b.length, b64: b.toString('base64') });
}

function fingerprintSHA256(keyBuf) {
  const crypto = require('crypto');
  const h = crypto.createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '');
  return 'SHA256:' + h;
}

// 生バイト送信（改行変換・文字コード変換なし。ファイル転送プロトコル用）
function writeRaw(id, bytes) {
  const entry = conns.get(id);
  if (!entry) return;
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (entry.monitor) monitorCapture(id, 'tx', b);
  if (entry.type === 'ssh' && entry.stream) entry.stream.write(b);
  else if (entry.type === 'telnet' && entry.sock) entry.sock.write(b);
  else if (entry.type === 'serial' && entry.port) { try { entry.port.write(b); } catch (_) {} }
}

// 受信データを文字コード変換して描画 + ログ
function handleIncomingData(wc, id, buf, isEcho) {
  const entry = conns.get(id);
  if (!entry) return;
  if (!isEcho && entry.monitor) monitorCapture(id, 'rx', buf);
  // ファイル転送セッション中は生バイトを横取りしてプロトコルへ
  if (entry.xfer) { try { entry.xfer.onData(buf); } catch (_) {} return; }
  let text;
  try { text = iconv.decode(buf, entry.enc || 'utf8'); }
  catch (_) { text = buf.toString('utf8'); }
  if (entry.logStream) {
    try {
      if (entry.logTs) {
        entry.logBuf = (entry.logBuf || '') + text;
        let nl;
        while ((nl = entry.logBuf.indexOf('\n')) >= 0) {
          const line = entry.logBuf.slice(0, nl + 1);
          entry.logBuf = entry.logBuf.slice(nl + 1);
          entry.logStream.write('[' + new Date().toLocaleTimeString('ja-JP', { hour12: false }) + '] ' + line);
        }
      } else {
        entry.logStream.write(text);
      }
    } catch (_) {}
  }
  send((entry && entry.wc) || wc, 'conn:data', { id, data: text });
}

// 改行変換 + 文字コードエンコードして送信
function writeToConn(id, str) {
  const entry = conns.get(id);
  if (!entry) return;
  let s = str;
  if (entry.newline && entry.newline !== 'cr') {
    if (entry.newline === 'lf') s = s.replace(/\r/g, '\n');
    else if (entry.newline === 'crlf') s = s.replace(/\r/g, '\r\n');
  }
  let bytes;
  try { bytes = iconv.encode(s, entry.enc || 'utf8'); }
  catch (_) { bytes = Buffer.from(s, 'utf8'); }
  if (entry.monitor) monitorCapture(id, 'tx', bytes);
  if (entry.type === 'ssh' && entry.stream) entry.stream.write(bytes);
  else if (entry.type === 'telnet' && entry.sock) entry.sock.write(bytes);
  else if (entry.type === 'serial' && entry.port) { try { entry.port.write(bytes); } catch (_) {} }
}

function closeConn(id) {
  const entry = conns.get(id);
  if (!entry) return;
  try { if (entry.logStream) entry.logStream.end(); } catch (_) {}
  try { if (entry.xfer) entry.xfer.abort(); } catch (_) {}
  try { (entry.fwdServers || []).forEach((s) => { try { s.close(); } catch (_) {} }); } catch (_) {}
  try { if (entry.type === 'ssh' && entry.client) entry.client.end(); } catch (_) {}
  try { if (entry.jumpClient) entry.jumpClient.end(); } catch (_) {}
  try { if (entry.type === 'telnet' && entry.sock) entry.sock.destroy(); } catch (_) {}
  try { if (entry.type === 'serial' && entry.port) { entry.port.close(); } } catch (_) {}
  try { if (entry.type === 'rdp' && entry.proc) { entry.proc.kill(); } } catch (_) {}
  try { (entry.editWatchers || []).forEach((p) => stopEditWatch(p)); } catch (_) {}
  conns.delete(id);
}

// ---------------------------------------------------------------------------
// シリアル(COM)コンソール接続 — serialport を Electron 内で直接利用 (N-API)
// ---------------------------------------------------------------------------
let SerialPortMod = null;
function getSerialPort() {
  if (SerialPortMod === null) {
    try { SerialPortMod = require('serialport').SerialPort; }
    catch (e) { SerialPortMod = false; }
  }
  return SerialPortMod;
}
function serialConnect(wc, id, cfg) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const entry = {
      type: 'serial', port: null, enc: cfg.encoding || 'utf8',
      newline: cfg.newline || 'cr', localEcho: !!cfg.localEcho, logStream: null, wc,
    };
    conns.set(id, entry);
    const SP = getSerialPort();
    if (!SP) { const m = 'serialport モジュールを読み込めません'; send(wc, 'conn:status', { id, status: 'error', message: m }); done({ ok: false, error: m }); return; }
    let port;
    try {
      port = new SP({
        path: cfg.serialPort, baudRate: Number(cfg.baud) || 9600,
        dataBits: Number(cfg.dataBits) || 8, parity: cfg.parity || 'none',
        stopBits: Number(cfg.stopBits) || 1,
        rtscts: cfg.flow === 'rtscts', xon: cfg.flow === 'xonxoff', xoff: cfg.flow === 'xonxoff',
        autoOpen: false,
      });
    } catch (e) { send(wc, 'conn:status', { id, status: 'error', message: e.message }); done({ ok: false, error: e.message }); return; }
    entry.port = port;
    port.on('data', (d) => handleIncomingData(wc, id, d));
    port.on('error', (e) => { send(wcOf(id, wc), 'conn:status', { id, status: 'error', message: e.message }); done({ ok: false, error: e.message }); });
    port.on('close', () => { send(wcOf(id, wc), 'conn:status', { id, status: 'closed' }); });
    port.open((err) => {
      if (err) { send(wc, 'conn:status', { id, status: 'error', message: err.message }); done({ ok: false, error: err.message }); return; }
      send(wc, 'conn:status', { id, status: 'connected' });
      if (cfg.loginCommands && cfg.loginCommands.trim()) {
        setTimeout(() => { for (const l of cfg.loginCommands.split('\n')) writeToConn(id, l + '\r'); }, 500);
      }
      done({ ok: true });
    });
  });
}
function listSerialPorts() {
  const SP = getSerialPort();
  if (!SP) return Promise.resolve([]);
  return SP.list()
    .then((l) => l.map((p) => ({ path: p.path, friendlyName: p.friendlyName, manufacturer: p.manufacturer })))
    .catch(() => []);
}

// ---------------------------------------------------------------------------
// RDP — Windows標準のリモートデスクトップ(mstsc)を .rdp ファイル生成して起動
// ---------------------------------------------------------------------------
function buildRdpFile(cfg, embedded) {
  const host = (cfg.host || '').trim();
  if (!host) throw new Error('ホストが指定されていません');
  const port = Number(cfg.port) || 3389;
  const user = (cfg.domain ? cfg.domain + '\\' : '') + (cfg.username || '');
  const lines = [];
  lines.push('full address:s:' + host + ':' + port);
  if (embedded) {
    // 埋め込み時: ペインのサイズをそのままリモート解像度にし、リサイズに追従(枠ぴったり)
    lines.push('screen mode id:i:1');
    lines.push('desktopwidth:i:' + (Number(cfg.paneWidth) || Number(cfg.width) || 1600));
    lines.push('desktopheight:i:' + (Number(cfg.paneHeight) || Number(cfg.height) || 900));
    lines.push('dynamic resolution:i:1');
  } else {
    lines.push('screen mode id:i:' + (cfg.fullscreen === false ? 1 : 2));
    if (cfg.fullscreen === false) {
      lines.push('desktopwidth:i:' + (Number(cfg.width) || 1280));
      lines.push('desktopheight:i:' + (Number(cfg.height) || 800));
    }
  }
  if (user) lines.push('username:s:' + user);
  lines.push('use multimon:i:' + (cfg.multimon ? 1 : 0));
  lines.push('redirectclipboard:i:' + (cfg.clipboard === false ? 0 : 1));
  if (cfg.drives) lines.push('drivestoredirect:s:*');
  if (cfg.adminSession) lines.push('administrative session:i:1');
  lines.push('authentication level:i:2');
  lines.push('prompt for credentials:i:0');
  if (cfg.password && user) {
    try {
      const psScript = 'Add-Type -AssemblyName System.Security; $pw=([Console]::In.ReadToEnd() -replace "[\\r\\n]+$",""); $b=[System.Text.Encoding]::Unicode.GetBytes($pw); $e=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); -join ($e | ForEach-Object { $_.ToString(\'x2\') })';
      const hex = cp.execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], { input: cfg.password, encoding: 'utf8', windowsHide: true }).trim();
      if (/^[0-9a-f]+$/i.test(hex)) lines.push('password 51:b:' + hex);
    } catch (_) {}
  }
  const file = path.join(app.getPath('temp'), 'waterm-rdp-' + Date.now() + '.rdp');
  fs.writeFileSync(file, lines.join('\r\n') + '\r\n', 'ascii');
  return file;
}

// 外部の mstsc ウィンドウで開く（埋め込み不可時のフォールバック）
function rdpLaunch(cfg) {
  return new Promise((resolve) => {
    try {
      if (process.platform !== 'win32') { resolve({ ok: false, error: 'RDPはWindowsでのみ利用できます' }); return; }
      const file = buildRdpFile(cfg, false);
      const p = spawn('mstsc', [file], { windowsHide: true, detached: true, stdio: 'ignore' });
      p.on('error', (e) => resolve({ ok: false, error: e.message }));
      p.unref();
      setTimeout(() => resolve({ ok: true, external: true }), 300);
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}

// mstsc を起動し、そのウィンドウを WaTerm のウィンドウ内に埋め込む
function rdpEmbed(wc, id, cfg) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve({ ok: false, error: 'RDPはWindowsでのみ利用できます' }); return; }
    const reqWin = BrowserWindow.fromWebContents(wc) || mainWin; // 要求元ウィンドウに埋め込む（分離ウィンドウ対応）
    if (!winembed.isAvailable || !reqWin) { rdpLaunch(cfg).then((r) => resolve(Object.assign({ embedded: false }, r))); return; }
    let file;
    try { file = buildRdpFile(cfg, true); }
    catch (e) { resolve({ ok: false, error: e.message }); return; }
    const proc = spawn('mstsc', [file], { detached: false, stdio: 'ignore' });
    const entry = { type: 'rdp', proc, hwnd: null, parent: winembed.hwndFromBuffer(reqWin.getNativeWindowHandle()) };
    conns.set(id, entry);
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    proc.on('error', (e) => done({ ok: false, error: e.message }));
    proc.on('exit', () => { send(wc, 'conn:status', { id, status: 'closed' }); });
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      let hwnd = null;
      try { hwnd = winembed.findWindowByPid(proc.pid); } catch (_) {}
      if (hwnd) {
        clearInterval(timer);
        entry.hwnd = hwnd;
        winembed.embed(hwnd, entry.parent);
        send(wc, 'conn:status', { id, status: 'connected' });
        done({ ok: true, embedded: true });
      } else if (tries > 75) { // 約15秒
        clearInterval(timer);
        done({ ok: false, error: 'RDPウィンドウを取得できませんでした' });
      }
    }, 200);
  });
}
function rdpPosition(id, rect) {
  const en = conns.get(id);
  if (!en || en.type !== 'rdp' || !en.hwnd) return;
  const clientH = winembed.clientHeight(en.parent);
  const dpr = rect.dpr || 1;
  const menuOffset = clientH - (rect.innerH || 0) * dpr;
  const x = rect.left * dpr, y = rect.top * dpr + menuOffset, w = rect.width * dpr, h = rect.height * dpr;
  winembed.move(en.hwnd, x, y, w, h);
}

// ---------------------------------------------------------------------------
// SSH 接続
// ---------------------------------------------------------------------------
// 実行環境(Electron=BoringSSL)が対応しないアルゴリズム名を全リストから除去
function stripAlgo(algos, name) {
  let removed = false;
  for (const k of Object.keys(algos)) {
    const i = algos[k].indexOf(name);
    if (i >= 0) { algos[k].splice(i, 1); removed = true; }
  }
  return removed;
}

// SSHポート転送(トンネル) — ssh -L/-R/-D 形式の行を解釈して設定
function handleSocks(sock, client) {
  let stage = 0;
  sock.on('data', (data) => {
    try {
      if (stage === 0) { if (data[0] !== 0x05) return sock.destroy(); sock.write(Buffer.from([0x05, 0x00])); stage = 1; return; }
      if (stage === 1) {
        if (data[0] !== 0x05 || data[1] !== 0x01) { sock.end(Buffer.from([0x05, 0x07, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
        const atyp = data[3]; let host, off;
        if (atyp === 1) { host = data[4] + '.' + data[5] + '.' + data[6] + '.' + data[7]; off = 8; }
        else if (atyp === 3) { const len = data[4]; host = data.slice(5, 5 + len).toString(); off = 5 + len; }
        else if (atyp === 4) { const p = []; for (let i = 0; i < 16; i += 2) p.push(data.readUInt16BE(4 + i).toString(16)); host = p.join(':'); off = 20; }
        else { sock.end(Buffer.from([0x05, 0x08, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
        const port = data.readUInt16BE(off);
        stage = 2;
        client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
          if (err) { try { sock.end(Buffer.from([0x05, 0x05, 0, 1, 0, 0, 0, 0, 0, 0])); } catch (_) {} return; }
          sock.write(Buffer.from([0x05, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]));
          sock.pipe(stream).pipe(sock);
        });
      }
    } catch (_) { try { sock.destroy(); } catch (_) {} }
  });
  sock.on('error', () => {});
}
function setupForwards(client, entry, cfg, wc, id) {
  if (!cfg.forwards) return;
  entry.fwdServers = entry.fwdServers || [];
  entry.fwdRemote = entry.fwdRemote || [];
  const note = (m) => send(wc, 'conn:data', { id, data: '\r\n\x1b[36m[転送] ' + m + '\x1b[0m\r\n' });
  for (const raw of String(cfg.forwards).split('\n')) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const type = (parts[0] || '').toUpperCase(); const spec = parts[1] || '';
    try {
      if (type === 'L') {
        const m = spec.match(/^(?:([^:]+):)?(\d+):([^:]+):(\d+)$/);
        if (!m) { note('Lの書式が不正: ' + line); continue; }
        const bind = m[1] || '127.0.0.1', lport = +m[2], dhost = m[3], dport = +m[4];
        const srv = net.createServer((sock) => {
          client.forwardOut(sock.remoteAddress || '127.0.0.1', sock.remotePort || 0, dhost, dport, (err, stream) => {
            if (err) { try { sock.destroy(); } catch (_) {} return; }
            sock.pipe(stream).pipe(sock);
          });
        });
        srv.on('error', (e) => note('ローカル ' + lport + ' エラー: ' + e.message));
        srv.listen(lport, bind, () => note('ローカル ' + bind + ':' + lport + ' → ' + dhost + ':' + dport));
        entry.fwdServers.push(srv);
      } else if (type === 'R') {
        const m = spec.match(/^(?:([^:]+):)?(\d+):([^:]+):(\d+)$/);
        if (!m) { note('Rの書式が不正: ' + line); continue; }
        const bind = m[1] || '127.0.0.1', rport = +m[2], dhost = m[3], dport = +m[4];
        entry.fwdRemote.push({ rport, dhost, dport });
        client.forwardIn(bind, rport, (err) => {
          if (err) note('リモート ' + rport + ' 失敗: ' + err.message);
          else note('リモート ' + bind + ':' + rport + ' → ' + dhost + ':' + dport);
        });
      } else if (type === 'D') {
        const m = spec.match(/^(?:([^:]+):)?(\d+)$/);
        if (!m) { note('Dの書式が不正: ' + line); continue; }
        const bind = m[1] || '127.0.0.1', lport = +m[2];
        const srv = net.createServer((sock) => handleSocks(sock, client));
        srv.on('error', (e) => note('SOCKS ' + lport + ' エラー: ' + e.message));
        srv.listen(lport, bind, () => note('SOCKS(動的) ' + bind + ':' + lport));
        entry.fwdServers.push(srv);
      } else { note('不明な転送種別: ' + line); }
    } catch (e) { note('転送設定エラー: ' + e.message); }
  }
  if (entry.fwdRemote.length) {
    client.on('tcp connection', (info, accept, reject) => {
      const r = entry.fwdRemote.find((x) => x.rport === info.destPort);
      if (!r) { try { reject(); } catch (_) {} return; }
      const stream = accept();
      const local = net.connect(r.dport, r.dhost, () => { local.pipe(stream).pipe(local); });
      local.on('error', () => { try { stream.end(); } catch (_) {} });
    });
  }
}

function sshConnect(wc, id, cfg) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const entry = {
      type: 'ssh', client: null, stream: null, sftp: null,
      enc: cfg.encoding || 'utf8', newline: cfg.newline || 'cr',
      localEcho: !!cfg.localEcho, logStream: null,
      host: cfg.host, port: cfg.port || 22, wc,
    };
    conns.set(id, entry);

    const known = readJson(KNOWN_FILE, {});
    const hkey = `${cfg.host}:${cfg.port || 22}`;
    // レガシー時のみ algorithms を上書き。非対応名は実行時に自動除去して再試行する
    const algos = cfg.legacy ? JSON.parse(JSON.stringify(LEGACY_ALGOS)) : null;
    let attempts = 0;
    let key = null;
    if (cfg.authType === 'key' && cfg.keyPath) {
      try { key = fs.readFileSync(cfg.keyPath); }
      catch (e) { done({ ok: false, error: '秘密鍵を読めません: ' + e.message }); return; }
    }

    const handleUnsupported = (msg, client) => {
      const m = /Unsupported algorithm:\s*([^\s]+)/i.exec(msg || '');
      if (m && algos && attempts < 25 && stripAlgo(algos, m[1])) {
        try { client.removeAllListeners(); client.end(); } catch (_) {}
        attempt();
        return true;
      }
      return false;
    };

    function attempt() {
      attempts++;
      const client = new Client();
      entry.client = client;
      client.on('ready', () => {
        setupForwards(client, entry, cfg, wc, id);
        client.shell({ term: cfg.termType || 'xterm-256color', cols: cfg.cols || 80, rows: cfg.rows || 24 }, (err, stream) => {
          if (err) { send(wc, 'conn:status', { id, status: 'error', message: err.message }); done({ ok: false, error: err.message }); return; }
          entry.stream = stream;
          stream.on('data', (d) => handleIncomingData(wc, id, d));
          stream.stderr.on('data', (d) => handleIncomingData(wc, id, d));
          stream.on('close', () => { send(wcOf(id, wc), 'conn:status', { id, status: 'closed' }); closeConn(id); });
          send(wcOf(id, wc), 'conn:status', { id, status: 'connected' });
          if (cfg.loginCommands && cfg.loginCommands.trim()) {
            setTimeout(() => { for (const line of cfg.loginCommands.split('\n')) writeToConn(id, line + '\r'); }, 600);
          }
          done({ ok: true });
        });
      });
      client.on('error', (err) => {
        if (handleUnsupported(err.message, client)) return;
        send(wc, 'conn:status', { id, status: 'error', message: err.message });
        done({ ok: false, error: err.message });
      });
      client.on('close', () => { if (!settled) return; send(wcOf(id, wc), 'conn:status', { id, status: 'closed' }); });
      client.on('keyboard-interactive', (name, instr, lang, prompts, cb) => cb(prompts.map(() => cfg.password || '')));

      const connectCfg = {
        host: cfg.host, port: cfg.port || 22, username: cfg.username,
        readyTimeout: (cfg.timeout || 20) * 1000,
        keepaliveInterval: cfg.keepalive ? cfg.keepalive * 1000 : 15000,
        tryKeyboard: true,
        hostVerifier: (keyBuf, verify) => {
          const fp = fingerprintSHA256(keyBuf);
          if (known[hkey]) {
            if (known[hkey] === fp) verify(true);
            else { send(wc, 'conn:data', { id, data: `\r\n\x1b[31m⚠ ホスト鍵が登録値と一致しません！中間者攻撃の可能性があります。\r\n  登録: ${known[hkey]}\r\n  今回: ${fp}\x1b[0m\r\n` }); verify(false); }
          } else {
            known[hkey] = fp; writeJson(KNOWN_FILE, known);
            send(wc, 'conn:data', { id, data: `\r\n\x1b[33m🔑 新しいホスト鍵を登録しました (TOFU): ${fp}\x1b[0m\r\n` });
            verify(true);
          }
        },
      };
      if (algos) connectCfg.algorithms = algos;
      if (key) { connectCfg.privateKey = key; if (cfg.passphrase) connectCfg.passphrase = cfg.passphrase; if (cfg.password) connectCfg.password = cfg.password; }
      else connectCfg.password = cfg.password || '';

      const doConnect = () => {
        try {
          if (entry.jumpClient) { // 踏み台(ProxyJump)経由：踏み台から target へ forwardOut して sock に使う
            entry.jumpClient.forwardOut('127.0.0.1', 0, cfg.host, cfg.port || 22, (err, stream) => {
              if (err) { send(wc, 'conn:status', { id, status: 'error', message: '踏み台経由の接続に失敗: ' + err.message }); done({ ok: false, error: err.message }); return; }
              connectCfg.sock = stream;
              try { client.connect(connectCfg); }
              catch (e2) { if (!handleUnsupported(e2.message, client)) { send(wc, 'conn:status', { id, status: 'error', message: e2.message }); done({ ok: false, error: e2.message }); } }
            });
          } else { client.connect(connectCfg); }
        } catch (e) {
          if (handleUnsupported(e.message, client)) return;
          send(wc, 'conn:status', { id, status: 'error', message: e.message });
          done({ ok: false, error: e.message });
        }
      };
      doConnect();
    }
    if (cfg.jump && cfg.jump.host) {
      connectJump(cfg.jump, (jc) => { entry.jumpClient = jc; send(wc, 'conn:data', { id, data: '\r\n\x1b[36m[踏み台] ' + cfg.jump.host + ' 経由で接続します\x1b[0m\r\n' }); attempt(); },
        (errMsg) => { send(wc, 'conn:status', { id, status: 'error', message: '踏み台接続に失敗: ' + errMsg }); done({ ok: false, error: errMsg }); });
    } else {
      attempt();
    }
  });
}
// 踏み台(ProxyJump)用のSSH接続を確立し、ready で onReady(client) を呼ぶ
function connectJump(jump, onReady, onErr) {
  const jc = new Client();
  let jkey = null;
  if (jump.authType === 'key' && jump.keyPath) { try { jkey = fs.readFileSync(jump.keyPath); } catch (e) { onErr('踏み台の秘密鍵を読めません: ' + e.message); return; } }
  const jalgos = jump.legacy ? JSON.parse(JSON.stringify(LEGACY_ALGOS)) : null;
  jc.on('ready', () => onReady(jc));
  jc.on('error', (e) => onErr(e.message));
  jc.on('keyboard-interactive', (n, i, l, p, cb) => cb(p.map(() => jump.password || '')));
  const jcfg = { host: jump.host, port: jump.port || 22, username: jump.username, readyTimeout: 20000, tryKeyboard: true };
  if (jalgos) jcfg.algorithms = jalgos;
  if (jkey) { jcfg.privateKey = jkey; if (jump.passphrase) jcfg.passphrase = jump.passphrase; if (jump.password) jcfg.password = jump.password; }
  else jcfg.password = jump.password || '';
  try { jc.connect(jcfg); } catch (e) { onErr(e.message); }
}

// ---------------------------------------------------------------------------
// Telnet 接続 (Tera Term 互換)
// ---------------------------------------------------------------------------
const T = { IAC: 255, DONT: 254, DO: 253, WONT: 252, WILL: 251, SB: 250, SE: 240, ECHO: 1, SGA: 3, TTYPE: 24, NAWS: 31 };
function telnetConnect(wc, id, cfg) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const sock = new net.Socket();
    const entry = {
      type: 'telnet', sock, enc: cfg.encoding || 'utf8',
      newline: cfg.newline || 'crlf', localEcho: !!cfg.localEcho, logStream: null,
      host: cfg.host, port: cfg.port || 23, termType: cfg.termType || 'xterm', wc,
    };
    conns.set(id, entry);

    sock.setTimeout((cfg.timeout || 20) * 1000);
    sock.on('timeout', () => { sock.destroy(); send(wc, 'conn:status', { id, status: 'error', message: '接続タイムアウト' }); done({ ok: false, error: '接続タイムアウト' }); });
    sock.connect(cfg.port || 23, cfg.host, () => {
      sock.setTimeout(0);
      send(wc, 'conn:status', { id, status: 'connected' });
      done({ ok: true });
    });

    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const out = [];
      let i = 0;
      while (i < buf.length) {
        if (buf[i] === T.IAC) {
          if (i + 1 >= buf.length) break;
          const cmd = buf[i + 1];
          if (cmd === T.IAC) { out.push(T.IAC); i += 2; continue; }
          if (cmd === T.DO || cmd === T.DONT || cmd === T.WILL || cmd === T.WONT) {
            if (i + 2 >= buf.length) break;
            const opt = buf[i + 2];
            // 最低限のネゴシエーション: SGA/TTYPE は WILL/DO、その他は拒否
            let resp;
            if (cmd === T.DO) resp = (opt === T.SGA || opt === T.TTYPE) ? T.WILL : T.WONT;
            else if (cmd === T.WILL) resp = (opt === T.SGA || opt === T.ECHO) ? T.DO : T.DONT;
            else resp = null;
            if (resp) sock.write(Buffer.from([T.IAC, resp, opt]));
            i += 3; continue;
          }
          if (cmd === T.SB) {
            let j = i + 2;
            while (j < buf.length && !(buf[j] === T.IAC && buf[j + 1] === T.SE)) j++;
            if (j + 1 >= buf.length) break;
            // TTYPE 要求には xterm を返す
            if (buf[i + 2] === T.TTYPE) sock.write(Buffer.from([T.IAC, T.SB, T.TTYPE, 0, ...Buffer.from(entry.termType || 'xterm'), T.IAC, T.SE]));
            i = j + 2; continue;
          }
          i += 2; continue;
        } else { out.push(buf[i]); i++; }
      }
      buf = buf.slice(i);
      if (out.length) handleIncomingData(wc, id, Buffer.from(out));
    });
    sock.on('error', (err) => { send(wcOf(id, wc), 'conn:status', { id, status: 'error', message: err.message }); done({ ok: false, error: err.message }); });
    sock.on('close', () => { send(wcOf(id, wc), 'conn:status', { id, status: 'closed' }); closeConn(id); });
  });
}

// ---------------------------------------------------------------------------
// SFTP
// ---------------------------------------------------------------------------
function getSftp(id) {
  return new Promise((resolve, reject) => {
    const entry = conns.get(id);
    if (!entry || entry.type !== 'ssh') return reject(new Error('SFTPはSSH接続でのみ利用できます'));
    if (entry.sftp) return resolve(entry.sftp);
    entry.client.sftp((err, sftp) => { if (err) reject(err); else { entry.sftp = sftp; resolve(sftp); } });
  });
}
function modeIsDir(mode) { return (mode & 0o170000) === 0o040000; }
function modeIsLink(mode) { return (mode & 0o170000) === 0o120000; }
function permString(mode) {
  const t = modeIsDir(mode) ? 'd' : modeIsLink(mode) ? 'l' : '-';
  const r = (m, s) => (mode & m ? s : '-');
  return t + r(0o400, 'r') + r(0o200, 'w') + r(0o100, 'x') + r(0o040, 'r') + r(0o020, 'w') + r(0o010, 'x') + r(0o004, 'r') + r(0o002, 'w') + r(0o001, 'x');
}

// ---------------------------------------------------------------------------
// ウィンドウ
// ---------------------------------------------------------------------------
let mainWin = null;
const windows = new Set();
const WEBPREFS = { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false };
// ウィンドウを登録。閉じられたら、そのウィンドウが描画先の接続だけを閉じる
function registerWindow(win) {
  windows.add(win);
  const wc = win.webContents; // ウィンドウ生存中に取得（closed後は win.webContents が例外になる）
  win.on('maximize', () => send(wc, 'win:state', { maximized: true }));
  win.on('unmaximize', () => send(wc, 'win:state', { maximized: false }));
  win.on('closed', () => {
    windows.delete(win);
    const cp2 = captureProcs.get(wc.id); if (cp2) { try { cp2.kill(); } catch (_) {} captureProcs.delete(wc.id); }
    const dp = diagProcs.get(wc.id); if (dp) { try { dp.kill(); } catch (_) {} diagProcs.delete(wc.id); }
    for (const [id, en] of conns) { if (en.wc === wc) closeConn(id); }
    if (win === mainWin) mainWin = null;
  });
}
function createWindow() {
  mainWin = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 560,
    backgroundColor: '#1e1e2e', title: '和ターミナル (WaTerm)', frame: false, webPreferences: WEBPREFS,
  });
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  buildMenu();
  registerWindow(mainWin);
}
// タブ分離用の新ウィンドウ（接続を引き継ぐ）
function createDetachedWindow(adopt) {
  const win = new BrowserWindow({
    width: 1100, height: 760, minWidth: 800, minHeight: 520,
    backgroundColor: '#1e1e2e', title: '和ターミナル (WaTerm)', frame: false, webPreferences: WEBPREFS,
  });
  try { const b = (mainWin || win).getBounds(); win.setPosition(b.x + 48, b.y + 48); } catch (_) {}
  win.pendingAdopt = Object.assign({ detached: true }, adopt); // 分離ウィンドウ：サイドバー非表示で開く
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  registerWindow(win);
  return win;
}

function buildMenu() {
  const wc = () => { const w = BrowserWindow.getFocusedWindow() || mainWin; return w && w.webContents; };
  const tpl = [
    { label: 'ファイル', submenu: [
      { label: '新規セッション', accelerator: 'CmdOrCtrl+N', click: () => send(wc(), 'menu', 'new-session') },
      { label: 'クイック接続', accelerator: 'CmdOrCtrl+K', click: () => send(wc(), 'menu', 'quick-connect') },
      { type: 'separator' },
      { label: 'セッションをエクスポート…', click: () => send(wc(), 'menu', 'export') },
      { label: 'セッションをインポート…', click: () => send(wc(), 'menu', 'import') },
      { type: 'separator' },
      { label: '終了', role: 'quit' },
    ]},
    { label: '編集', submenu: [
      { label: 'コピー', role: 'copy' },
      { label: '貼り付け', role: 'paste' },
      { label: 'すべて選択', role: 'selectAll' },
    ]},
    { label: 'ターミナル', submenu: [
      { label: '新しいタブ', accelerator: 'CmdOrCtrl+Shift+T', click: () => send(wc(), 'menu', 'new-tab') },
      { label: 'タブを閉じる', accelerator: 'CmdOrCtrl+W', click: () => send(wc(), 'menu', 'close-tab') },
      { type: 'separator' },
      { label: '文字を大きく', accelerator: 'CmdOrCtrl+Plus', click: () => send(wc(), 'menu', 'font-inc') },
      { label: '文字を小さく', accelerator: 'CmdOrCtrl+-', click: () => send(wc(), 'menu', 'font-dec') },
      { label: '検索', accelerator: 'CmdOrCtrl+F', click: () => send(wc(), 'menu', 'find') },
      { type: 'separator' },
      { label: 'ターミナルログを保存…', click: () => send(wc(), 'menu', 'log-start') },
      { label: 'ログ保存を停止', click: () => send(wc(), 'menu', 'log-stop') },
      { label: '全タブへ送信(MultiExec)', accelerator: 'CmdOrCtrl+Shift+M', click: () => send(wc(), 'menu', 'broadcast') },
    ]},
    { label: '表示', submenu: [
      { label: 'テーマ切替(ダーク/ライト)', click: () => send(wc(), 'menu', 'toggle-theme') },
      { label: 'サイドバー表示切替', accelerator: 'CmdOrCtrl+B', click: () => send(wc(), 'menu', 'toggle-sidebar') },
      { label: 'SFTPパネル表示切替', accelerator: 'CmdOrCtrl+Shift+S', click: () => send(wc(), 'menu', 'toggle-sftp') },
      { label: 'ログにタイムスタンプを付ける(切替)', click: () => send(wc(), 'menu', 'toggle-log-ts') },
      { type: 'separator' },
      { label: '開発者ツール', role: 'toggleDevTools' },
      { label: '再読み込み', role: 'reload' },
    ]},
    { label: 'ヘルプ', submenu: [
      { label: 'バージョン情報', click: () => showAbout(BrowserWindow.getFocusedWindow()) },
    ]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}
function showAbout(win) {
  dialog.showMessageBox(win || mainWin, {
    type: 'info', title: 'バージョン情報',
    message: '和ターミナル (WaTerm)',
    detail: `日本語SSH / Telnet / シリアル / RDP / SFTP クライアント\nバージョン ${app.getVersion()}\n\nElectron ${process.versions.electron} / Node ${process.versions.node}\n対応: SSH(レガシー暗号) / Telnet / シリアル / RDP / SFTP / 通信モニタ・pcap / tshark / Shift_JIS・EUC-JP`,
    buttons: ['OK'],
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('sessions:load', () => loadSessions());
ipcMain.handle('sessions:save', (e, data) => saveSessions(data));
ipcMain.handle('settings:load', () => readJson(SET_FILE, {}));
ipcMain.handle('settings:save', (e, data) => writeJson(SET_FILE, data));
ipcMain.handle('snippets:load', () => readJson(SNIP_FILE, []));
ipcMain.handle('snippets:save', (e, data) => writeJson(SNIP_FILE, data));

ipcMain.handle('secure:encrypt', (e, plain) => encryptSecret(plain));
ipcMain.handle('secure:decrypt', (e, stored) => decryptSecret(stored));
ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.on('clipboard:write', (e, t) => clipboard.writeText(t || ''));

ipcMain.handle('conn:open', async (e, { id, cfg }) => {
  const c = { ...cfg };
  if (c.passwordStored) c.password = decryptSecret(c.passwordStored);
  if (c.protocol === 'serial') return serialConnect(e.sender, id, c);
  if (c.protocol === 'telnet') return telnetConnect(e.sender, id, c);
  return sshConnect(e.sender, id, c);
});
ipcMain.handle('serial:list', () => listSerialPorts());
ipcMain.handle('rdp:launch', (e, cfg) => rdpLaunch(cfg || {}));
ipcMain.handle('rdp:embed', (e, { id, cfg }) => {
  const c = { ...cfg };
  if (c.passwordStored) c.password = decryptSecret(c.passwordStored);
  return rdpEmbed(e.sender, id, c);
});
ipcMain.on('rdp:position', (e, { id, rect }) => rdpPosition(id, rect));
ipcMain.on('rdp:show', (e, { id, visible }) => { const en = conns.get(id); if (en && en.type === 'rdp' && en.hwnd) winembed.show(en.hwnd, visible); });
ipcMain.on('conn:input', (e, { id, data }) => {
  const entry = conns.get(id);
  if (entry && entry.xfer) return; // ファイル転送中は端末入力を無視
  writeToConn(id, data);
  if (entry && entry.localEcho) handleIncomingData(e.sender, id, iconv.encode(data.replace(/\r/g, '\r\n'), entry.enc || 'utf8'), true);
});
ipcMain.on('conn:resize', (e, { id, cols, rows }) => {
  const entry = conns.get(id);
  if (entry && entry.type === 'ssh' && entry.stream) { try { entry.stream.setWindow(rows, cols, 0, 0); } catch (_) {} }
});
ipcMain.on('conn:close', (e, { id }) => closeConn(id));

ipcMain.handle('conn:setEncoding', (e, { id, encoding }) => { const en = conns.get(id); if (en) en.enc = encoding; return true; });
ipcMain.handle('conn:setNewline', (e, { id, newline }) => { const en = conns.get(id); if (en) en.newline = newline; return true; });
ipcMain.handle('conn:setLocalEcho', (e, { id, on }) => { const en = conns.get(id); if (en) en.localEcho = on; return true; });

// ログ保存
ipcMain.handle('log:start', async (e, { id, defaultName, timestamp }) => {
  const r = await dialog.showSaveDialog(mainWin, { title: 'ターミナルログの保存先', defaultPath: path.join(app.getPath('documents'), defaultName || 'terminal.log'), filters: [{ name: 'ログ', extensions: ['log', 'txt'] }] });
  if (r.canceled || !r.filePath) return { ok: false };
  const en = conns.get(id); if (!en) return { ok: false, error: '接続がありません' };
  try { en.logStream = fs.createWriteStream(r.filePath, { flags: 'a' }); en.logTs = !!timestamp; en.logBuf = ''; en.logStream.write(`\n--- ログ開始 ${new Date().toLocaleString('ja-JP')}${timestamp ? ' (タイムスタンプ付き)' : ''} ---\n`); }
  catch (er) { return { ok: false, error: er.message }; }
  return { ok: true, path: r.filePath };
});
ipcMain.handle('log:stop', (e, { id }) => { const en = conns.get(id); if (en && en.logStream) { try { en.logStream.end(); } catch (_) {} en.logStream = null; en.logTs = false; en.logBuf = ''; return true; } return false; });

// Break送信(シリアル)
ipcMain.handle('serial:break', (e, { id }) => {
  const en = conns.get(id);
  if (!en || en.type !== 'serial' || !en.port) return { ok: false, error: 'シリアル接続ではありません' };
  try { en.port.set({ brk: true }, () => setTimeout(() => { try { en.port.set({ brk: false }, () => {}); } catch (_) {} }, 350)); return { ok: true }; }
  catch (er) { return { ok: false, error: er.message }; }
});

// ファイル送信(テキストの中身を端末へ流し込む。行ごとに遅延)
ipcMain.handle('conn:sendFile', async (e, { id, delayMs }) => {
  const en = conns.get(id);
  if (!en) return { ok: false, error: '接続がありません' };
  const r = await dialog.showOpenDialog(mainWin, { title: '送信するテキストファイル', properties: ['openFile'] });
  if (r.canceled || !r.filePaths.length) return { ok: false };
  let buf;
  try { buf = fs.readFileSync(r.filePaths[0]); } catch (er) { return { ok: false, error: er.message }; }
  let text;
  try { text = iconv.decode(buf, en.enc || 'utf8'); } catch (_) { text = buf.toString('utf8'); }
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const d = Number(delayMs) || 40;
  let i = 0;
  const tick = () => {
    if (i >= lines.length) return;
    // 最終行が空(末尾改行)ならスキップ
    if (i === lines.length - 1 && lines[i] === '') return;
    writeToConn(id, lines[i] + '\r');
    i++;
    setTimeout(tick, d);
  };
  tick();
  return { ok: true, lines: lines.length, name: path.basename(r.filePaths[0]) };
});

// ファイル転送プロトコル (XMODEM / XMODEM-1K / YMODEM)
const PROTO_LABEL = { xmodem: 'XMODEM', xmodem1k: 'XMODEM-1K', ymodem: 'YMODEM', zmodem: 'ZMODEM', kermit: 'Kermit' };
const MULTIFILE = { ymodem: true, zmodem: true, kermit: true }; // ファイル名/複数ファイルを扱うプロトコル
ipcMain.handle('transfer:start', async (e, { id, proto, dir }) => {
  const en = conns.get(id);
  if (!en) return { ok: false, error: '接続がありません' };
  if (en.type === 'rdp') return { ok: false, error: 'この接続では使えません' };
  if (en.xfer) return { ok: false, error: '転送が進行中です' };
  if (!PROTO_LABEL[proto]) return { ok: false, error: '未対応のプロトコルです' };
  const wc = e.sender;
  const termMsg = (m, color) => send(wc, 'conn:data', { id, data: '\r\n\x1b[' + (color || '36') + 'm[転送] ' + m + '\x1b[0m\r\n' });
  let files = null, saveFile = null;
  if (dir === 'send') {
    const r = await dialog.showOpenDialog(mainWin, { title: '送信するファイル', properties: MULTIFILE[proto] ? ['openFile', 'multiSelections'] : ['openFile'] });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    try { files = r.filePaths.map((p) => ({ name: path.basename(p), data: fs.readFileSync(p) })); }
    catch (er) { return { ok: false, error: er.message }; }
  } else {
    if (MULTIFILE[proto]) {
      const r = await dialog.showOpenDialog(mainWin, { title: '受信ファイルの保存先フォルダ', properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled || !r.filePaths.length) return { ok: false };
      const dir2 = r.filePaths[0];
      saveFile = async (name, buf) => { const p = path.join(dir2, name || ('received_' + Date.now())); fs.writeFileSync(p, buf); return p; };
    } else {
      let dl; try { dl = app.getPath('downloads'); } catch (_) { dl = app.getPath('documents'); }
      const r = await dialog.showSaveDialog(mainWin, { title: '受信ファイルの保存先', defaultPath: path.join(dl, 'received.bin') });
      if (r.canceled || !r.filePath) return { ok: false };
      saveFile = async (_name, buf) => { fs.writeFileSync(r.filePath, buf); return r.filePath; };
    }
  }
  let lastPct = -1;
  en.xfer = transfer.startTransfer({
    proto, dir,
    send: (bytes) => writeRaw(id, bytes),
    log: (m) => termMsg(m),
    progress: (p) => {
      const cur = p.sent != null ? p.sent : p.received; const tot = p.total;
      const pct = tot ? Math.floor(cur / tot * 100) : null;
      if (pct !== null && pct !== lastPct) { lastPct = pct; send(wc, 'conn:data', { id, data: '\r\x1b[36m[転送] ' + (p.name || '') + ' ' + pct + '% (' + cur + '/' + tot + ')\x1b[0m' }); }
    },
    done: (r) => { en.xfer = null; if (r && r.ok) termMsg('すべて完了しました', 32); else termMsg('失敗: ' + ((r && r.error) || '不明なエラー'), 31); send(wc, 'transfer:done', { id, result: r }); },
  });
  termMsg(PROTO_LABEL[proto] + ' ' + (dir === 'send' ? '送信' : '受信') + 'を開始しました。相手側で対応コマンド（例: sx/sb/sz, rx/rb/rz）を実行してください', 33);
  return { ok: true, started: true };
});
ipcMain.on('transfer:abort', (e, { id }) => { const en = conns.get(id); if (en && en.xfer) { try { en.xfer.abort(); } catch (_) {} } });

// テキストファイル読込（マクロ .ttl 等）
ipcMain.handle('dialog:openText', async (e, { exts }) => {
  const filters = [];
  if (exts && exts.length) filters.push({ name: 'マクロ', extensions: exts });
  filters.push({ name: 'すべて', extensions: ['*'] });
  const r = await dialog.showOpenDialog(mainWin, { title: 'マクロファイルを開く', properties: ['openFile'], filters });
  if (r.canceled || !r.filePaths.length) return { ok: false };
  try {
    let buf = fs.readFileSync(r.filePaths[0]);
    // BOM 除去 + UTF-8 デコード（Shift_JIS の .ttl も簡易対応）
    let text;
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) text = buf.slice(3).toString('utf8');
    else {
      text = buf.toString('utf8');
      if (/�/.test(text)) { try { text = iconv.decode(buf, 'shift_jis'); } catch (_) {} }
    }
    return { ok: true, name: path.basename(r.filePaths[0]), content: text };
  } catch (er) { return { ok: false, error: er.message }; }
});

// SFTP IPC
ipcMain.handle('sftp:realpath', async (e, { id, p }) => {
  try { const sftp = await getSftp(id); return await new Promise((res, rej) => sftp.realpath(p || '.', (err, ap) => err ? rej(err) : res(ap))); }
  catch (er) { return { error: er.message }; }
});
ipcMain.handle('sftp:list', async (e, { id, p }) => {
  try {
    const sftp = await getSftp(id);
    const list = await new Promise((res, rej) => sftp.readdir(p, (err, l) => err ? rej(err) : res(l)));
    return list.map((it) => ({
      name: it.filename,
      size: it.attrs.size,
      mtime: it.attrs.mtime,
      isDir: modeIsDir(it.attrs.mode),
      isLink: modeIsLink(it.attrs.mode),
      perms: permString(it.attrs.mode),
    })).sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
  } catch (er) { return { error: er.message }; }
});
ipcMain.handle('sftp:download', async (e, { id, remotePath, name }) => {
  try {
    const sftp = await getSftp(id);
    const r = await dialog.showSaveDialog(mainWin, { title: 'ダウンロード先', defaultPath: path.join(app.getPath('downloads'), name) });
    if (r.canceled || !r.filePath) return { ok: false };
    await new Promise((res, rej) => sftp.fastGet(remotePath, r.filePath, (err) => err ? rej(err) : res()));
    return { ok: true, path: r.filePath };
  } catch (er) { return { ok: false, error: er.message }; }
});
ipcMain.handle('sftp:upload', async (e, { id, remoteDir }) => {
  try {
    const sftp = await getSftp(id);
    const r = await dialog.showOpenDialog(mainWin, { title: 'アップロードするファイル', properties: ['openFile', 'multiSelections'] });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    for (const fp of r.filePaths) {
      const rp = remoteDir.replace(/\/$/, '') + '/' + path.basename(fp);
      await new Promise((res, rej) => sftp.fastPut(fp, rp, (err) => err ? rej(err) : res()));
    }
    return { ok: true, count: r.filePaths.length };
  } catch (er) { return { ok: false, error: er.message }; }
});
// ドラッグ&ドロップで渡されたローカルパスを remoteDir へアップロード
ipcMain.handle('sftp:uploadPaths', async (e, { id, remoteDir, paths }) => {
  try {
    const sftp = await getSftp(id);
    let count = 0;
    for (const fp of (paths || [])) {
      let st; try { st = fs.statSync(fp); } catch (_) { continue; }
      if (st.isDirectory()) continue; // フォルダは対象外（ファイルのみ）
      const rp = remoteDir.replace(/\/$/, '') + '/' + path.basename(fp);
      await new Promise((res, rej) => sftp.fastPut(fp, rp, (err) => err ? rej(err) : res()));
      count++;
    }
    return { ok: true, count };
  } catch (er) { return { ok: false, error: er.message }; }
});
ipcMain.handle('sftp:mkdir', async (e, { id, p }) => {
  try { const sftp = await getSftp(id); await new Promise((res, rej) => sftp.mkdir(p, (err) => err ? rej(err) : res())); return { ok: true }; }
  catch (er) { return { ok: false, error: er.message }; }
});
ipcMain.handle('sftp:delete', async (e, { id, p, isDir }) => {
  try { const sftp = await getSftp(id); await new Promise((res, rej) => (isDir ? sftp.rmdir : sftp.unlink).call(sftp, p, (err) => err ? rej(err) : res())); return { ok: true }; }
  catch (er) { return { ok: false, error: er.message }; }
});
ipcMain.handle('sftp:rename', async (e, { id, oldP, newP }) => {
  try { const sftp = await getSftp(id); await new Promise((res, rej) => sftp.rename(oldP, newP, (err) => err ? rej(err) : res())); return { ok: true }; }
  catch (er) { return { ok: false, error: er.message }; }
});

// SFTP 即時編集（edit-in-place）：リモートファイルを一時DLしてローカルの既定エディタで開き、
// 保存（mtime変化）を検知して自動で再アップロードする。
const editWatches = new Map(); // localPath -> { id, remotePath, name }
function stopEditWatch(localPath) {
  if (!editWatches.has(localPath)) return;
  try { fs.unwatchFile(localPath); } catch (_) {}
  editWatches.delete(localPath);
}
ipcMain.handle('sftp:edit', async (e, { id, remotePath, name }) => {
  try {
    const sftp = await getSftp(id);
    const dir = path.join(os.tmpdir(), 'waterm-edit');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    // Windowsで不正な文字のみ除去（日本語等は保持）。一意化のため接頭辞を付与
    const safe = String(name || 'file').replace(/[\\/:*?"<>|]/g, '_');
    const localPath = path.join(dir, Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36) + '-' + safe);
    await new Promise((res, rej) => sftp.fastGet(remotePath, localPath, (err) => err ? rej(err) : res()));
    const entry = conns.get(id);
    let busy = false, lastMtime = 0;
    try { lastMtime = fs.statSync(localPath).mtimeMs; } catch (_) {}
    const onChange = async (curr) => {
      if (!curr || curr.mtimeMs === lastMtime) return; // 変化なし
      lastMtime = curr.mtimeMs;
      if (busy) return; busy = true;
      try {
        const s = await getSftp(id);
        await new Promise((res, rej) => s.fastPut(localPath, remotePath, (err) => err ? rej(err) : res()));
        send(wcOf(id, e.sender), 'sftp:editEvent', { ok: true, name, remotePath, ts: Date.now() });
      } catch (er) {
        send(wcOf(id, e.sender), 'sftp:editEvent', { ok: false, name, remotePath, error: er.message });
      } finally { busy = false; }
    };
    // watchFile はパス監視のためエディタの「原子的保存(別名書込み+リネーム)」にも追従する
    fs.watchFile(localPath, { interval: 800 }, onChange);
    editWatches.set(localPath, { id, remotePath, name });
    if (entry) (entry.editWatchers = entry.editWatchers || []).push(localPath);
    const opened = await shell.openPath(localPath); // 既定アプリで開く（空文字なら成功）
    return { ok: true, localPath, openError: opened || '' };
  } catch (er) { return { ok: false, error: er.message }; }
});
// 編集監視の停止（タブ側から個別に解除する場合）
ipcMain.on('sftp:editStop', (e, { id }) => {
  const entry = conns.get(id);
  if (!entry || !entry.editWatchers) return;
  for (const p of entry.editWatchers) stopEditWatch(p);
  entry.editWatchers = [];
});

// ダイアログ
ipcMain.handle('dialog:pickKey', async () => {
  const r = await dialog.showOpenDialog(mainWin, { title: '秘密鍵ファイルを選択', properties: ['openFile'] });
  return (r.canceled || !r.filePaths.length) ? null : r.filePaths[0];
});
ipcMain.handle('dialog:exportSessions', async (e, data) => {
  const r = await dialog.showSaveDialog(mainWin, { title: 'セッションのエクスポート', defaultPath: path.join(app.getPath('documents'), 'waterm-sessions-export.json') });
  if (r.canceled || !r.filePath) return { ok: false };
  writeJson(r.filePath, data); return { ok: true, path: r.filePath };
});
ipcMain.handle('dialog:importSessions', async () => {
  const r = await dialog.showOpenDialog(mainWin, { title: 'セッションのインポート', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePaths.length) return { ok: false };
  return { ok: true, data: readJson(r.filePaths[0], null) };
});
ipcMain.handle('app:openExternal', (e, url) => shell.openExternal(url));

// ---------------------------------------------------------------------------
// 自動更新（electron-updater）
// ---------------------------------------------------------------------------
function broadcastAll(channel, payload) { for (const w of windows) { try { if (!w.isDestroyed()) w.webContents.send(channel, payload); } catch (_) {} } }
function setupUpdater() {
  if (!autoUpdater || !app.isPackaged) return; // 開発実行(electron .)では無効
  try {
    autoUpdater.logger = null; // 配布先未設定時のログノイズを抑制
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', (info) => broadcastAll('update:available', { version: info && info.version }));
    autoUpdater.on('update-downloaded', (info) => broadcastAll('update:downloaded', { version: info && info.version }));
    autoUpdater.on('error', () => {}); // 配布先未設定/オフライン時は静かに無視
    autoUpdater.checkForUpdates().catch(() => {});
  } catch (_) {}
}
ipcMain.handle('update:check', async () => {
  if (!autoUpdater) return { ok: false, error: 'updater 無効' };
  if (!app.isPackaged) return { ok: false, dev: true };
  try {
    const r = await autoUpdater.checkForUpdates();
    const latest = r && r.updateInfo ? r.updateInfo.version : null;
    return { ok: true, current: app.getVersion(), latest, available: !!(latest && latest !== app.getVersion()) };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.on('update:install', () => { try { if (autoUpdater) autoUpdater.quitAndInstall(); } catch (_) {} });

// タブのドラッグ移動。レンダラはタブ列から外して離した時だけこれを呼ぶ。
//   別ウィンドウの上 → そのウィンドウへ取り込み／それ以外(同じウィンドウ上を含む) → 新ウィンドウへ分離
ipcMain.handle('window:relocate', (e, { id, session, status, x, y }) => {
  const en = conns.get(id);
  if (!en) return { ok: false, error: '接続がありません' };
  if (en.type === 'rdp') return { ok: false, error: 'RDPタブは移動に対応していません' };
  const srcWin = BrowserWindow.fromWebContents(e.sender);
  const inBounds = (w) => { try { const b = w.getBounds(); return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height; } catch (_) { return false; } };
  // ソース以外で、ドロップ座標を含む別ウィンドウがあればそこへ取り込み（＝戻す/まとめる）
  let target = null;
  for (const w of windows) {
    if (w === srcWin || w.isDestroyed()) continue;
    if (!w.isMinimized() && inBounds(w)) { target = w; break; }
  }
  if (target) {
    en.wc = target.webContents;
    target.webContents.send('tab:adopt', { id, session, status });
    try { target.focus(); } catch (_) {}
    return { ok: true, moved: true };
  }
  // 別ウィンドウの上でない → 列から外して離した時点で新ウィンドウへ分離（同じウィンドウ上でも分離する）
  createDetachedWindow({ id, session, status });
  return { ok: true, moved: true };
});


// 新ウィンドウのレンダラ準備完了 → 引き継ぎタブを送り、描画先(wc)を張り替える
ipcMain.on('window:ready', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && win.pendingAdopt) {
    const adopt = win.pendingAdopt; win.pendingAdopt = null;
    const en = conns.get(adopt.id);
    if (en) en.wc = e.sender; // 以後この接続の出力は新ウィンドウへ
    e.sender.send('tab:adopt', adopt);
  }
});
// 自ウィンドウを閉じる（分離ウィンドウが空になったとき）
ipcMain.on('window:close', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w && !w.isDestroyed()) w.close(); });

// カスタムタイトルバーのウィンドウ操作
ipcMain.on('win:minimize', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.minimize(); });
ipcMain.on('win:maximize', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (!w) return; if (w.isMaximized()) w.unmaximize(); else w.maximize(); });
ipcMain.on('win:close', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w && !w.isDestroyed()) w.close(); });
ipcMain.handle('win:isMaximized', (e) => { const w = BrowserWindow.fromWebContents(e.sender); return !!(w && w.isMaximized()); });
ipcMain.on('win:devtools', (e) => { try { e.sender.toggleDevTools(); } catch (_) {} });
ipcMain.on('app:quit', () => app.quit());
ipcMain.on('app:about', (e) => showAbout(BrowserWindow.fromWebContents(e.sender)));

// ---------------------------------------------------------------------------
// 通信モニタ（WaTermのセッション送受信）
// ---------------------------------------------------------------------------
ipcMain.handle('monitor:toggle', (e, { id, on }) => {
  const en = conns.get(id); if (!en) return { ok: false, error: '接続がありません' };
  en.monitor = !!on;
  if (on && !en.monitorLog) { en.monitorLog = []; en.monitorBytes = 0; }
  return { ok: true, on: en.monitor, frames: en.monitorLog ? en.monitorLog.length : 0 };
});
ipcMain.handle('monitor:state', (e, { id }) => {
  const en = conns.get(id); if (!en) return { ok: false };
  return { ok: true, on: !!en.monitor, frames: en.monitorLog ? en.monitorLog.length : 0, bytes: en.monitorBytes || 0 };
});
ipcMain.handle('monitor:clear', (e, { id }) => { const en = conns.get(id); if (en) { en.monitorLog = []; en.monitorBytes = 0; } return { ok: true }; });
ipcMain.handle('monitor:export', async (e, { id }) => {
  const en = conns.get(id); if (!en || !en.monitorLog || !en.monitorLog.length) return { ok: false, error: '記録がありません' };
  const win = BrowserWindow.fromWebContents(e.sender) || mainWin;
  const r = await dialog.showSaveDialog(win, { title: '通信モニタを pcap で保存', defaultPath: path.join(app.getPath('documents'), 'waterm-capture.pcap'), filters: [{ name: 'pcap', extensions: ['pcap'] }] });
  if (r.canceled || !r.filePath) return { ok: false };
  try {
    const buf = pcap.buildPcap(en.monitorLog, { remoteIp: en.host, remotePort: en.port });
    fs.writeFileSync(r.filePath, buf);
    return { ok: true, path: r.filePath, frames: en.monitorLog.length };
  } catch (er) { return { ok: false, error: er.message }; }
});

// ---------------------------------------------------------------------------
// パケットキャプチャ（インストール済み Wireshark の tshark を利用）
// ---------------------------------------------------------------------------
let tsharkPathCache;
function findTshark() {
  if (tsharkPathCache !== undefined) return tsharkPathCache;
  const cands = [
    'C:/Program Files/Wireshark/tshark.exe',
    'C:/Program Files (x86)/Wireshark/tshark.exe',
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Wireshark', 'tshark.exe') : null,
  ].filter(Boolean);
  tsharkPathCache = cands.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } }) || null;
  return tsharkPathCache;
}
const captureProcs = new Map(); // webContents.id -> child process
ipcMain.handle('capture:tshark', () => ({ path: findTshark() }));
ipcMain.handle('capture:interfaces', async () => {
  const tsh = findTshark(); if (!tsh) return { ok: false, error: 'tshark が見つかりません（Wireshark をインストールしてください）' };
  return new Promise((resolve) => {
    cp.execFile(tsh, ['-D'], { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !stdout) return resolve({ ok: false, error: (stderr || err.message || '').trim() });
      const list = [];
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = /^(\d+)\.\s+(.+)$/.exec(line.trim());
        if (m) { const rest = m[2]; const fm = /\(([^)]+)\)\s*$/.exec(rest); list.push({ id: m[1], name: fm ? fm[1] : rest, raw: rest }); }
      }
      resolve({ ok: true, interfaces: list });
    });
  });
});
ipcMain.handle('capture:start', (e, { iface, filter }) => {
  const tsh = findTshark(); if (!tsh) return { ok: false, error: 'tshark が見つかりません' };
  const wcid = e.sender.id;
  if (captureProcs.has(wcid)) { try { captureProcs.get(wcid).kill(); } catch (_) {} captureProcs.delete(wcid); }
  const SEP = '\x1f';
  const args = ['-i', String(iface || '1'), '-l', '-n',
    '-T', 'fields', '-e', 'frame.number', '-e', 'frame.time_relative', '-e', 'ip.src', '-e', 'ip.dst',
    '-e', '_ws.col.Protocol', '-e', 'frame.len', '-e', '_ws.col.Info', '-E', 'separator=' + SEP];
  if (filter && filter.trim()) { args.push('-Y', filter.trim()); }
  let proc;
  try { proc = spawn(tsh, args, { windowsHide: true }); }
  catch (er) { return { ok: false, error: er.message }; }
  captureProcs.set(wcid, proc);
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let nl; while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, ''); buf = buf.slice(nl + 1);
      if (!line) continue;
      const f = line.split(SEP);
      send(e.sender, 'capture:packet', { no: f[0], time: f[1], src: f[2], dst: f[3], proto: f[4], len: f[5], info: f[6] || '' });
    }
  });
  let errBuf = '';
  proc.stderr.on('data', (d) => { errBuf += d.toString('utf8'); });
  proc.on('close', (code) => { captureProcs.delete(wcid); send(e.sender, 'capture:end', { code, error: code ? errBuf.trim() : '' }); });
  proc.on('error', (er) => { captureProcs.delete(wcid); send(e.sender, 'capture:end', { code: -1, error: er.message }); });
  return { ok: true };
});
ipcMain.on('capture:stop', (e) => { const p = captureProcs.get(e.sender.id); if (p) { try { p.kill(); } catch (_) {} captureProcs.delete(e.sender.id); } });

// ---------------------------------------------------------------------------
// ネットワーク診断（ローカル実行: ping / tracert / nslookup）
// 自分のPCから対象ホストへコマンドを実行し、出力を逐次描画先へ流す。
// 出力は日本語Windowsのコンソール文字コード(CP932)なので iconv で復号する。
// ---------------------------------------------------------------------------
const diagProcs = new Map(); // webContents.id -> child process（1ウィンドウ1実行）
ipcMain.handle('diag:run', (e, { kind, host, count }) => {
  const h = String(host || '').trim();
  if (!h) return { ok: false, error: 'ホスト名/IPを入力してください' };
  // 引数に使える形だけ許可（spawnはshell無しだが、紛れ込み防止に最低限のサニタイズ）
  if (!/^[A-Za-z0-9._:\-%]+$/.test(h)) return { ok: false, error: 'ホスト名に使用できない文字が含まれています' };
  const wcid = e.sender.id;
  const prev = diagProcs.get(wcid); if (prev) { try { prev.kill(); } catch (_) {} diagProcs.delete(wcid); }
  let cmd, args;
  if (kind === 'ping') {
    const n = parseInt(count, 10);
    cmd = 'ping';
    args = (!n || n <= 0) ? ['-t', h] : ['-n', String(Math.min(n, 1000)), h]; // 0/空＝連続(-t)
  } else if (kind === 'tracert') {
    cmd = 'tracert'; args = ['-h', '30', h];
  } else if (kind === 'nslookup') {
    cmd = 'nslookup'; args = [h];
  } else return { ok: false, error: '不明な診断種別です' };
  let child;
  try { child = spawn(cmd, args, { windowsHide: true }); }
  catch (er) { return { ok: false, error: er.message }; }
  diagProcs.set(wcid, child);
  const dec = (b) => { try { return iconv.decode(b, 'cp932'); } catch (_) { return b.toString('utf8'); } };
  child.stdout.on('data', (b) => send(e.sender, 'diag:data', { text: dec(b) }));
  child.stderr.on('data', (b) => send(e.sender, 'diag:data', { text: dec(b) }));
  child.on('error', (er) => { if (diagProcs.get(wcid) === child) diagProcs.delete(wcid); send(e.sender, 'diag:end', { code: -1, error: er.message }); });
  child.on('close', (code) => { if (diagProcs.get(wcid) === child) diagProcs.delete(wcid); send(e.sender, 'diag:end', { code }); });
  return { ok: true, cmd: cmd + ' ' + args.join(' ') };
});
ipcMain.on('diag:stop', (e) => { const c = diagProcs.get(e.sender.id); if (c) { try { c.kill(); } catch (_) {} diagProcs.delete(e.sender.id); } });

// ---------------------------------------------------------------------------
// 埋め込みRDP(ネイティブ子ウィンドウ)をChromium描画面より前面に出すため、
// GPU合成を無効化してHWND-z順を有効にする(これが無いとDirectCompositionの描画面が子窓を覆う)
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-direct-composition');

app.whenReady().then(() => { createWindow(); setTimeout(setupUpdater, 3000); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
