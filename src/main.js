'use strict';
const { app, BrowserWindow, ipcMain, Menu, dialog, shell, safeStorage, clipboard, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');
const cp = require('child_process');
const { spawn } = cp;
// 古い暗号(レガシーDH)対応: ssh2 を require する前に crypto をパッチする
const legacyDH = require('./legacy-dh');
const dragchip = require('./dragchip');
const pluginHost = require('./plugin-host');
const crypto = require('crypto');
const vault = require('./vault');
const { parseSshConfig } = require('./sshconfig');
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
const VAULT_FILE = path.join(DATA_DIR, 'waterm-vault.json'); // salt + 検証トークン（マスター鍵そのものは保存しない）
// プラグイン置き場（フォルダが正）。同梱プラグインもここへ書き出して管理する。
// フォルダを置く/消す/編集するだけで追加/削除/変更できる（要再起動）。
const USER_PLUGINS_DIR = path.join(DATA_DIR, 'plugins');
// 管理用データ（seed 状態・アーカイブ展開）は plugins/ を汚さないよう内部フォルダへ
const PLUGIN_CACHE_DIR = path.join(DATA_DIR, 'plugins-cache');
try { fs.mkdirSync(USER_PLUGINS_DIR, { recursive: true }); } catch (_) {}
try { fs.mkdirSync(PLUGIN_CACHE_DIR, { recursive: true }); } catch (_) {}
// ユーザーフォルダから読むプラグイン backend が、アプリ同梱の node_modules
// （koffi / iconv-lite 等）を解決できるよう、グローバル検索パスに追加する。
try {
  const Module = require('module');
  const appNM = path.resolve(__dirname, '..', 'node_modules');
  process.env.NODE_PATH = appNM + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : '');
  Module._initPaths();
} catch (_) {}
let masterKey = null; // マスターパスワード解錠中のみメモリ上に保持

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
// 既定の暗号化（OSキーチェーン or base64）。マスターパスワード無効時・解除時に使う。
function encryptDefault(plain) {
  if (!plain) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(plain).toString('base64');
    }
  } catch (_) {}
  return 'b64:' + Buffer.from(plain, 'utf8').toString('base64');
}
// マスター鍵が解錠されていれば mpw: で暗号化、無ければ既定方式。
function encryptSecret(plain) {
  if (!plain) return '';
  if (masterKey) { try { return 'mpw:' + vault.encrypt(plain, masterKey); } catch (_) {} }
  return encryptDefault(plain);
}
function decryptSecret(stored) {
  if (!stored) return '';
  try {
    if (stored.startsWith('mpw:')) {
      if (!masterKey) return ''; // 未解錠なら復号不可（接続は失敗し、UIが解錠を促す）
      return vault.decrypt(stored.slice(4), masterKey);
    }
    if (stored.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    }
    if (stored.startsWith('b64:')) {
      return Buffer.from(stored.slice(4), 'base64').toString('utf8');
    }
  } catch (_) {}
  return '';
}

// レガシー(旧暗号)アルゴリズム一覧は src/ssh-algos.js に分離
const LEGACY_ALGOS = require('./ssh-algos');

// ---------------------------------------------------------------------------
// 接続管理
// ---------------------------------------------------------------------------
/** id -> { type, client, stream, sock, sftp, enc, newline, localEcho, logStream } */
const conns = new Map();

// プラグインが接続の送受信データを傍受するためのフック
//   observers: 観測（通信モニタ等）。rx/tx 両方。返り値は無視。
//   rxConsumers: rx を消費（ファイル転送等）。true を返すと本体の以降の処理を止める。
const connDataObservers = [];
const connRxConsumers = [];
function emitConnData(id, dir, buf, entry, isEcho) { for (const fn of connDataObservers) { try { fn({ id, dir, buf, entry, isEcho }); } catch (_) {} } }
function consumeRx(id, buf, entry) { for (const fn of connRxConsumers) { try { if (fn({ id, buf, entry }) === true) return true; } catch (_) {} } return false; }

function send(wc, channel, payload) {
  if (wc && !wc.isDestroyed()) wc.send(channel, payload);
}
// 接続の現在の描画先 webContents（ウィンドウ分離で entry.wc が張り替わる）
function wcOf(id, fallback) { const en = conns.get(id); return (en && en.wc) || fallback; }

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
  emitConnData(id, 'tx', b, entry, false);
  if (entry.type === 'ssh' && entry.stream) entry.stream.write(b);
  else if (entry.type === 'telnet' && entry.sock) entry.sock.write(b);
  else if (entry.type === 'serial' && entry.port) { try { entry.port.write(b); } catch (_) {} }
}

// 受信データを文字コード変換して描画 + ログ
function handleIncomingData(wc, id, buf, isEcho) {
  const entry = conns.get(id);
  if (!entry) return;
  // プラグイン傍受（観測＝通信モニタ記録・ZMODEM自動検知 / 消費＝ファイル転送中の生バイト横取り）
  emitConnData(id, 'rx', buf, entry, isEcho);
  if (consumeRx(id, buf, entry)) return;
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
  emitConnData(id, 'tx', bytes, entry, false);
  if (entry.type === 'ssh' && entry.stream) entry.stream.write(bytes);
  else if (entry.type === 'telnet' && entry.sock) entry.sock.write(bytes);
  else if (entry.type === 'serial' && entry.port) { try { entry.port.write(bytes); } catch (_) {} }
  else if (entry.type === 'shell' && entry.proc) { try { entry.proc.stdin.write(bytes); } catch (_) {} }
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
  try { if (entry.type === 'shell' && entry.proc) { entry.proc.kill(); } } catch (_) {}
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
        try { client.setNoDelay(true); } catch (_) {} // TCP_NODELAY: Nagle無効化で打鍵の遅延(最大40ms)を解消（Tera Term同様）
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
  jc.on('ready', () => { try { jc.setNoDelay(true); } catch (_) {} onReady(jc); });
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
    try { sock.setNoDelay(true); } catch (_) {} // TCP_NODELAY: Nagle無効化で打鍵遅延を解消
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

// ローカルシェル（PowerShell/cmd/WSL）をパイプで起動する簡易シェル。
// ネイティブ依存なし。完全なPTYではない（TUI/行編集は限定的）ためローカルエコー前提で使う。
// 出力をUTF-8に固定する初期化を各シェルに与え、iconvのenc=utf8と一致させる。
function shellConnect(wc, id, cfg) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const kind = cfg.shellKind || 'powershell';
    let file, args;
    if (kind === 'cmd') { file = process.env.ComSpec || 'cmd.exe'; args = ['/k', 'chcp 65001>nul']; }
    else if (kind === 'wsl') { file = 'wsl.exe'; args = []; }
    else if (kind === 'pwsh') { file = 'pwsh.exe'; args = ['-NoLogo', '-NoExit', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8']; }
    else { file = 'powershell.exe'; args = ['-NoLogo', '-NoExit', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8;[Console]::InputEncoding=[Text.Encoding]::UTF8']; }
    let proc;
    try { proc = spawn(file, args, { cwd: os.homedir(), env: process.env, windowsHide: true }); }
    catch (e) { send(wc, 'conn:status', { id, status: 'error', message: e.message }); return done({ ok: false, error: e.message }); }
    const entry = { type: 'shell', proc, enc: cfg.encoding || 'utf8', newline: cfg.newline || 'crlf', localEcho: cfg.localEcho !== false, logStream: null, shellKind: kind, wc };
    conns.set(id, entry);
    proc.stdout.on('data', (d) => handleIncomingData(wcOf(id, wc), id, d));
    proc.stderr.on('data', (d) => handleIncomingData(wcOf(id, wc), id, d));
    proc.on('error', (e) => { send(wcOf(id, wc), 'conn:status', { id, status: 'error', message: 'シェルを起動できません: ' + e.message }); done({ ok: false, error: e.message }); });
    proc.on('exit', (code) => { send(wcOf(id, wc), 'conn:status', { id, status: 'closed' }); closeConn(id); });
    send(wc, 'conn:status', { id, status: 'connected' });
    done({ ok: true });
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
// プラグインがウィンドウ破棄時の後始末（webContents別ジョブの停止等）を登録するフック
const windowClosedHooks = [];
const WEBPREFS = { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false };
// ウィンドウを登録。閉じられたら、そのウィンドウが描画先の接続だけを閉じる
function registerWindow(win) {
  windows.add(win);
  const wc = win.webContents; // ウィンドウ生存中に取得（closed後は win.webContents が例外になる）
  win.on('maximize', () => send(wc, 'win:state', { maximized: true }));
  win.on('unmaximize', () => send(wc, 'win:state', { maximized: false }));
  win.on('closed', () => {
    windows.delete(win);
    for (const fn of windowClosedHooks) { try { fn(wc.id); } catch (_) {} }
    for (const [id, en] of conns) { if (en.wc === wc) closeConn(id); }
    if (win === mainWin) mainWin = null;
  });
}
const APP_ICON = path.join(__dirname, '..', 'build', 'icon.ico'); // ウィンドウ/タスクバー用（dev版でも即反映）
function createWindow() {
  mainWin = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 560, icon: APP_ICON,
    backgroundColor: '#1e1e2e', title: '和ターミナル (WaTerm)', frame: false, webPreferences: WEBPREFS,
  });
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  buildMenu();
  registerWindow(mainWin);
}
// タブ分離用の新ウィンドウ（接続を引き継ぐ）
function createDetachedWindow(adopt) {
  const win = new BrowserWindow({
    width: 1100, height: 760, minWidth: 800, minHeight: 520, icon: APP_ICON,
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

// --- マスターパスワード保管庫 ---
const VAULT_TOKEN = 'WATERM_VAULT_v1'; // 解錠検証用の既知平文
ipcMain.handle('vault:status', () => ({ enabled: fs.existsSync(VAULT_FILE), unlocked: !!masterKey }));
ipcMain.handle('vault:enable', (e, { password }) => {
  if (fs.existsSync(VAULT_FILE)) return { ok: false, error: 'マスターパスワードは既に有効です' };
  if (!password) return { ok: false, error: 'パスワードが空です' };
  try {
    const salt = crypto.randomBytes(16);
    const key = vault.deriveKey(password, salt);
    writeJson(VAULT_FILE, { v: 1, salt: salt.toString('base64'), verifier: vault.encrypt(VAULT_TOKEN, key) });
    masterKey = key;
    return { ok: true };
  } catch (er) { return { ok: false, error: er.message }; }
});
ipcMain.handle('vault:unlock', (e, { password }) => {
  const meta = readJson(VAULT_FILE, null);
  if (!meta) return { ok: false, error: 'マスターパスワードは未設定です' };
  try {
    const key = vault.deriveKey(password, Buffer.from(meta.salt, 'base64'));
    if (vault.decrypt(meta.verifier, key) !== VAULT_TOKEN) return { ok: false, error: 'パスワードが違います' };
    masterKey = key;
    return { ok: true };
  } catch (_) { return { ok: false, error: 'パスワードが違います' }; }
});
ipcMain.handle('vault:lock', () => { masterKey = null; return { ok: true }; });
ipcMain.handle('vault:disable', () => {
  if (!masterKey) return { ok: false, error: '先に解錠してください' };
  try { fs.unlinkSync(VAULT_FILE); } catch (_) {}
  masterKey = null;
  return { ok: true };
});
// 保存済み秘密文字列の配列を再暗号化。toDefault=true で既定方式へ、false で現在のマスター鍵で mpw へ。
ipcMain.handle('vault:reencrypt', (e, { list, toDefault }) => {
  const enc = toDefault ? encryptDefault : encryptSecret;
  return (list || []).map((s) => { if (!s) return s; let p = ''; try { p = decryptSecret(s); } catch (_) {} return p ? enc(p) : s; });
});
ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.on('clipboard:write', (e, t) => clipboard.writeText(t || ''));

ipcMain.handle('conn:open', async (e, { id, cfg }) => {
  const c = { ...cfg };
  if (c.passwordStored) c.password = decryptSecret(c.passwordStored);
  if (c.protocol === 'serial') return serialConnect(e.sender, id, c);
  if (c.protocol === 'telnet') return telnetConnect(e.sender, id, c);
  if (c.protocol === 'shell') return shellConnect(e.sender, id, c);
  return sshConnect(e.sender, id, c);
});
ipcMain.handle('serial:list', () => listSerialPorts());
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

ipcMain.handle('sessions:importSshConfig', async () => {
  const def = path.join(os.homedir(), '.ssh', 'config');
  let file = def;
  if (!fs.existsSync(def)) {
    const r = await dialog.showOpenDialog(mainWin, { title: 'ssh_config を選択', properties: ['openFile'] });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    file = r.filePaths[0];
  }
  try { return { ok: true, sessions: parseSshConfig(fs.readFileSync(file, 'utf8')), path: file }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ---------------------------------------------------------------------------
// 自動更新（electron-updater）
// ---------------------------------------------------------------------------
function broadcastAll(channel, payload) { for (const w of windows) { try { if (!w.isDestroyed()) w.webContents.send(channel, payload); } catch (_) {} } }
// 更新イベントの配線（起動直後に1回。手動チェックより前に必ず登録しておく）
let updaterReady = false;
function initUpdater() {
  if (!autoUpdater || !app.isPackaged || updaterReady) return; // 開発実行(electron .)では無効
  try {
    autoUpdater.logger = null; // 配布先未設定時のログノイズを抑制
    autoUpdater.autoDownload = false;      // 「アップグレードしますか？」で OK されてからDLする
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', (info) => broadcastAll('update:available', { version: info && info.version }));
    autoUpdater.on('update-not-available', () => broadcastAll('update:none', { version: app.getVersion() }));
    autoUpdater.on('download-progress', (p) => broadcastAll('update:progress', { percent: Math.round((p && p.percent) || 0) }));
    autoUpdater.on('update-downloaded', (info) => {
      broadcastAll('update:downloaded', { version: info && info.version });
      // 利用者は「アップグレードしますか？」で既に同意済み → サイレント(/S)で適用し自動再起動。
      // quitAndInstall(isSilent=true, isForceRunAfter=true): NSISウィザードを出さずバックグラウンド更新。
      setTimeout(() => { try { autoUpdater.quitAndInstall(true, true); } catch (_) {} }, 1500);
    });
    autoUpdater.on('error', () => broadcastAll('update:error', {})); // 配布先未設定/オフライン時
    updaterReady = true;
  } catch (_) {}
}
function setupUpdater() { // 起動少し後に最初の自動チェック
  if (!autoUpdater || !app.isPackaged) return;
  initUpdater();
  try { autoUpdater.checkForUpdates().catch(() => {}); } catch (_) {}
}
ipcMain.handle('update:check', async () => {
  if (!autoUpdater) return { ok: false, error: 'updater 無効' };
  if (!app.isPackaged) return { ok: false, dev: true }; // dev(electron .)では不可
  initUpdater();
  try {
    const r = await autoUpdater.checkForUpdates(); // 結果は update:available / update:none イベントで通知
    const latest = r && r.updateInfo ? r.updateInfo.version : null;
    return { ok: true, current: app.getVersion(), latest, available: !!(latest && latest !== app.getVersion()) };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.on('update:download', () => { try { if (autoUpdater) autoUpdater.downloadUpdate().catch(() => {}); } catch (_) {} });
ipcMain.on('update:install', () => { try { if (autoUpdater) autoUpdater.quitAndInstall(true, true); } catch (_) {} });

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

// タブ切り離しドラッグの追従チップ（Win32レイヤードウィンドウ＝DWM描画でHWアクセラ無効でも表示／ウィンドウ外・別モニタOK）
// レンダラから前乗算BGRA(物理px)とDIP座標を受け取り、screen.dipToScreenPointで物理座標へ変換して配置。
ipcMain.handle('dragchip:available', () => !!dragchip.isAvailable);
function dipToPhys(x, y) { try { return screen.dipToScreenPoint({ x: Math.round(x), y: Math.round(y) }); } catch (_) { return { x: Math.round(x), y: Math.round(y) }; } }
let chipW = 0, chipH = 0; // 直近のチップ物理サイズ（端での反転判定に使う）
// カーソル物理座標(p)にチップを置く際、画面の作業領域からはみ出す端では反対側へ反転する。
function chipPlace(p) {
  let x = p.x + 16, y = p.y + 18;
  try {
    const wa = screen.getDisplayNearestPoint({ x: p.x, y: p.y }).workArea; // {x,y,width,height} 物理px
    if (chipW && x + chipW > wa.x + wa.width) x = p.x - chipW - 16;   // 右端 → カーソル左へ
    if (x < wa.x) x = wa.x;
    if (chipH && y + chipH > wa.y + wa.height) y = p.y - chipH - 18;  // 下端 → カーソル上へ
    if (y < wa.y) y = wa.y;
  } catch (_) {}
  return { x: Math.round(x), y: Math.round(y) };
}
ipcMain.on('dragchip:show', (e, { bgra, w, h, x, y }) => {
  if (!dragchip.isAvailable || !bgra || !w || !h) return;
  const buf = Buffer.isBuffer(bgra) ? bgra : Buffer.from(bgra.buffer || bgra);
  chipW = w; chipH = h;
  const q = chipPlace(dipToPhys(x, y));
  dragchip.show(buf, w, h, q.x, q.y);
});
ipcMain.on('dragchip:move', (e, { x, y }) => { if (!dragchip.isAvailable) return; const q = chipPlace(dipToPhys(x, y)); dragchip.move(q.x, q.y); });
ipcMain.on('dragchip:hide', () => { if (dragchip.isAvailable) dragchip.hide(); });


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
// アプリ全体を再起動（プラグインの有効/無効を反映するため。backendはmainプロセスで読むため再読込では不足）
ipcMain.on('app:relaunch', () => { try { app.relaunch(); } catch (_) {} app.exit(0); });
ipcMain.on('app:about', (e) => showAbout(BrowserWindow.fromWebContents(e.sender)));


// ---------------------------------------------------------------------------
// 描画モード（起動時にsettings.jsonから読む。切替には再起動が必要）
//   高速モード(perfMode, 既定ON): GPUアクセラ有効＋WebGLレンダラでネイティブ級に軽い。
//     代わりにRDP埋め込み不可（GPU合成が子HWNDを覆う）→外部mstscへ自動フォールバック。
//     一部環境(このPC等)のGPUプロセス サンドボックスACCESS_DENIEDクラッシュ回避に
//     disable-gpu-sandbox を併用（描画/動作に無害）。
//   通常モード(perfMode=false): HWアクセラ無効化でRDPをウィンドウ内に埋め込み可（描画はソフトウェア）。
let PERF_MODE = true;
try { const s = JSON.parse(fs.readFileSync(SET_FILE, 'utf8')); if (s && typeof s.perfMode === 'boolean') PERF_MODE = s.perfMode; } catch (_) {}
// セーフ起動: 高速モードで描画が壊れてメニューに到達できない環境の救済。
//   ・起動引数 --safe  または  ・%APPDATA%\waterm\SAFE_MODE ファイルが在ると perfMode を強制OFF。
// どちらもコード変更なしに戻せる導線（後者はメニュー不要でファイルを置くだけ）。
let SAFE_MODE = false;
try {
  if (process.argv.includes('--safe')) SAFE_MODE = true;
  else if (fs.existsSync(path.join(DATA_DIR, 'SAFE_MODE'))) SAFE_MODE = true;
} catch (_) {}
if (SAFE_MODE) PERF_MODE = false;
if (PERF_MODE) {
  app.commandLine.appendSwitch('disable-gpu-sandbox'); // GPUサンドボックス起因のクラッシュ回避（環境依存）
} else {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-direct-composition');
}
ipcMain.handle('app:perfMode', () => PERF_MODE);

// ---------------------------------------------------------------------------
// プラグイン基盤
//   backend の activate(host) に本体内部を渡す。プラグインは host 経由で
//   IPC 登録・送信・接続テーブル参照・ウィンドウ破棄時の後始末を行う。
// ---------------------------------------------------------------------------
function disabledPluginSet() { const s = readJson(SET_FILE, {}); return new Set(Array.isArray(s.disabledPlugins) ? s.disabledPlugins : []); }

const pluginBackendHost = {
  // IPC 登録
  handle: (channel, fn) => ipcMain.handle(channel, fn),
  on: (channel, fn) => ipcMain.on(channel, fn),
  removeHandler: (channel) => { try { ipcMain.removeHandler(channel); } catch (_) {} },
  // 送信
  send,                                   // send(wc, channel, payload)
  broadcastAll,                           // broadcastAll(channel, payload)
  // 接続テーブル
  conns,
  getConn: (id) => conns.get(id),
  wcOf,
  writeToConn,
  writeRaw,
  // ウィンドウ破棄時フック（webContents.id を受け取る）
  onWindowClosed: (fn) => { windowClosedHooks.push(fn); },
  // 送受信データ傍受（観測=モニタ / rx消費=ファイル転送）
  onConnData: (fn) => { connDataObservers.push(fn); },
  onConnConsumeRx: (fn) => { connRxConsumers.push(fn); },
  // 本体の状態（プラグインが参照）
  getPerfMode: () => PERF_MODE,
  getMainWindow: () => mainWin,
  // データ保存先・ユーティリティ
  paths: { data: DATA_DIR, config: path.join(DATA_DIR, 'configs') },
  readJson, writeJson,
  // Electron / Node の共有物（プラグインが必要に応じて使う）
  electron: { app, dialog, shell, BrowserWindow, screen, clipboard, safeStorage },
  node: { fs, path, os, net, spawn, cp, iconv },
};

// プラグイン1件のレンダラ用マニフェスト（資産URL/パネルHTML）。file:// で読む。
function pluginManifest(p) {
  const assetUrl = (rel) => require('url').pathToFileURL(path.join(p.dir, rel)).href;
  return {
    id: p.id,
    name: p.name,
    rendererUrl: p.renderer ? assetUrl(p.renderer) : null,
    styleUrl: p.style ? assetUrl(p.style) : null,
    panelHtml: p.panel ? (() => { try { return fs.readFileSync(path.join(p.dir, p.panel), 'utf8'); } catch (_) { return null; } })() : null,
  };
}
// 起動時マニフェスト（レンダラのローダ用）。有効プラグインの資産URL/パネルHTMLを返す。
ipcMain.handle('plugins:manifests', () => {
  const dis = disabledPluginSet();
  return pluginHost.discover(USER_PLUGINS_DIR, PLUGIN_CACHE_DIR)
    .filter((p) => (p.core || !dis.has(p.id)) && (p.renderer || p.panel || p.style))
    .map(pluginManifest);
});
// 管理UI用：全プラグインの一覧＋有効/無効＋組込か否か
ipcMain.handle('plugins:list', () => {
  const dis = disabledPluginSet();
  return pluginHost.discover(USER_PLUGINS_DIR, PLUGIN_CACHE_DIR).map((p) => ({ id: p.id, name: p.name, description: p.description, core: p.core, builtin: p.builtin, archived: p.archived, enabled: p.core || !dis.has(p.id) }));
});
// ユーザープラグインのフォルダを OS のファイラで開く
ipcMain.handle('plugins:openDir', () => {
  try { fs.mkdirSync(USER_PLUGINS_DIR, { recursive: true }); } catch (_) {}
  shell.openPath(USER_PLUGINS_DIR);
  return { ok: true, dir: USER_PLUGINS_DIR };
});
// 有効/無効の切替（settings.disabledPlugins を更新。反映は再読み込み）
ipcMain.handle('plugins:setEnabled', (e, { id, on }) => {
  const s = readJson(SET_FILE, {});
  const set = new Set(Array.isArray(s.disabledPlugins) ? s.disabledPlugins : []);
  if (on) set.delete(id); else set.add(id);
  s.disabledPlugins = [...set];
  writeJson(SET_FILE, s);
  return { ok: true, enabled: on };
});

// 同梱プラグインを <id>.wtp（単一ファイル）へ seed / バージョン同期（フォルダが正）
try { pluginHost.syncBundled(USER_PLUGINS_DIR, PLUGIN_CACHE_DIR); } catch (e) { console.error('[plugin] syncBundled 失敗:', e); }
// 置かれたアーカイブ(.wtp/.zip)を内部キャッシュへ展開してから読み込む
try { pluginHost.prepareArchives(USER_PLUGINS_DIR, PLUGIN_CACHE_DIR); } catch (e) { console.error('[plugin] prepareArchives 失敗:', e); }
// backend を読み込む（有効なもののみ activate）。実体フォルダから読む
pluginHost.loadBackends(pluginBackendHost, disabledPluginSet(), USER_PLUGINS_DIR, PLUGIN_CACHE_DIR);

// 起動時点で存在するプラグイン ID を「投入済み」として記録（ライブ追加の重複防止）
const loadedPluginIds = new Set(pluginHost.discover(USER_PLUGINS_DIR, PLUGIN_CACHE_DIR).map((p) => p.id));

// プラグインフォルダを監視し、ファイル/フォルダ投入時に再起動なしで反映する。
//   新規（未投入かつ有効）は backend を activate し、renderer へ資産を送って即注入。
//   削除/更新は完全反映に再起動が要るため、その旨だけ通知する。
function refreshPlugins() {
  try { pluginHost.prepareArchives(USER_PLUGINS_DIR, PLUGIN_CACHE_DIR); } catch (e) { console.error('[plugin] prepareArchives 失敗:', e); }
  const dis = disabledPluginSet();
  const cur = pluginHost.discover(USER_PLUGINS_DIR, PLUGIN_CACHE_DIR);
  const curIds = new Set(cur.map((p) => p.id));
  const added = [];
  for (const p of cur) {
    if (loadedPluginIds.has(p.id)) continue;                 // 既存はスキップ
    loadedPluginIds.add(p.id);
    added.push(p.id);
    const enabled = p.core || !dis.has(p.id);
    if (!enabled) continue;                                  // 無効なら一覧表示のみ（ロードしない）
    if (p.backend) {
      try { const m = require(path.join(p.dir, p.backend)); if (m && typeof m.activate === 'function') m.activate(pluginBackendHost); }
      catch (e) { console.error('[plugin] ライブ backend 失敗:', p.id, e); }
    }
    if (p.renderer || p.panel || p.style) broadcastAll('plugins:liveAdd', pluginManifest(p));
  }
  const removed = [...loadedPluginIds].filter((id) => !curIds.has(id));
  broadcastAll('plugins:changed', { added, removed, needRestart: removed.length > 0 });
}
function setupPluginWatcher() {
  let timer = null;
  try {
    fs.watch(USER_PLUGINS_DIR, { persistent: false, recursive: true }, () => {
      clearTimeout(timer); timer = setTimeout(() => { try { refreshPlugins(); } catch (e) { console.error('[plugin] refresh 失敗:', e); } }, 600);
    });
  } catch (e) { console.error('[plugin] フォルダ監視の開始に失敗:', e); }
}

try { app.setAppUserModelId('jp.waterm.app'); } catch (_) {} // Windowsタスクバーのアイコン紐付け
app.whenReady().then(() => { createWindow(); initUpdater(); setTimeout(setupUpdater, 3000); setupPluginWatcher(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
