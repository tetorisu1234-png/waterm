'use strict';
// ---------------------------------------------------------------------------
// 内蔵ファイルサーバ（TFTP / HTTP / FTP）
//   Cisco 等の `copy tftp` / `copy http` / `copy ftp` 運用や、簡易なファイル
//   配布・受け取りを WaTerm 単体で完結させるための軽量サーバ群。
//   - 1プロトコルにつき同時に1インスタンス（ポート占有のため）。
//   - 進捗/接続/転送はすべて log() 経由で呼び出し元（main）へ通知し、
//     main がレンダラの「🗄 サーバ」パネルへ流す。
//   依存は Node 標準のみ（dgram/http/net/fs/path）。
// ---------------------------------------------------------------------------
const dgram = require('dgram');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

let logCb = null;
function setLogger(fn) { logCb = fn; }
function log(proto, msg, level) { if (logCb) { try { logCb({ proto, ts: Date.now(), msg, level: level || 'info' }); } catch (_) {} } }

// 公開ルート配下に閉じ込める（ディレクトリトラバーサル防止）
function safeJoin(root, name) {
  const clean = String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const full = path.resolve(root, clean);
  const base = path.resolve(root);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

// ---------------------------------------------------------------------------
// TFTP (RFC 1350 + RFC 2347/2348/2349: blksize / tsize / timeout の OACK 対応)
// ---------------------------------------------------------------------------
const OP = { RRQ: 1, WRQ: 2, DATA: 3, ACK: 4, ERROR: 5, OACK: 6 };
let tftp = null; // { sock, root, writable, port }

function tftpReadStr(buf, off) {
  let e = off; while (e < buf.length && buf[e] !== 0) e++;
  return [buf.toString('ascii', off, e), e + 1];
}
// ERROR を送ってから（送信完了コールバックで）ソケットを閉じる。
// 同期 close() だと UDP データグラムが送出前に破棄され、相手に届かない。
function tftpError(sock, rinfo, code, message) {
  const m = Buffer.from(message || 'error', 'ascii');
  const b = Buffer.alloc(4 + m.length + 1);
  b.writeUInt16BE(OP.ERROR, 0); b.writeUInt16BE(code, 2); m.copy(b, 4); b[b.length - 1] = 0;
  try { sock.send(b, rinfo.port, rinfo.address, () => { try { sock.close(); } catch (_) {} }); }
  catch (_) { try { sock.close(); } catch (_) {} }
}
// RRQ/WRQ のオプションを解析（blksize/tsize/timeout）
function tftpParseOptions(buf, off) {
  const opts = {};
  while (off < buf.length) {
    let key, val;
    [key, off] = tftpReadStr(buf, off); if (!key) break;
    [val, off] = tftpReadStr(buf, off);
    opts[key.toLowerCase()] = val;
  }
  return opts;
}

function handleTftp(msg, rinfo, conf) {
  if (msg.length < 2) return;
  const op = msg.readUInt16BE(0);
  if (op !== OP.RRQ && op !== OP.WRQ) return; // 転送中の DATA/ACK は各転送ソケットが処理
  const [filename, o1] = tftpReadStr(msg, 2);
  const [mode, o2] = tftpReadStr(msg, o1);
  const opts = tftpParseOptions(msg, o2);
  const full = safeJoin(conf.root, filename);
  const who = rinfo.address + ':' + rinfo.port;
  // 転送専用ソケット（新しい TID）を開く
  const xs = dgram.createSocket('udp4');
  xs.bind(0, () => {
    if (op === OP.RRQ) tftpServeRead(xs, rinfo, full, filename, opts, who);
    else tftpServeWrite(xs, rinfo, full, filename, opts, who, conf);
  });
  xs.on('error', () => { try { xs.close(); } catch (_) {} });
}

function tftpNegBlksize(opts) {
  let bs = parseInt(opts.blksize, 10);
  if (!bs || bs < 8) bs = 512; if (bs > 65464) bs = 65464;
  return bs;
}
function tftpSendOack(xs, rinfo, ackOpts) {
  const parts = [Buffer.from([0, OP.OACK])];
  for (const k of Object.keys(ackOpts)) {
    parts.push(Buffer.from(k, 'ascii'), Buffer.from([0]), Buffer.from(String(ackOpts[k]), 'ascii'), Buffer.from([0]));
  }
  const b = Buffer.concat(parts);
  try { xs.send(b, rinfo.port, rinfo.address); } catch (_) {}
}

// サーバ→クライアント（routerの copy tftp flash 等＝ダウンロード）
function tftpServeRead(xs, rinfo, full, filename, opts, who) {
  if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    log('tftp', `読み取り要求 ${filename} → 見つかりません (${who})`, 'warn');
    tftpError(xs, rinfo, 1, 'File not found'); return; // tftpError が送信後に close する
  }
  const size = fs.statSync(full).size;
  const blksize = tftpNegBlksize(opts);
  log('tftp', `送信開始 ${filename} (${fmtBytes(size)}) → ${who}`);
  let data; try { data = fs.readFileSync(full); } catch (e) { tftpError(xs, rinfo, 2, 'Read error'); return; }

  let block = 0, done = false, timer = null, retries = 0;
  const ackOpts = {};
  if (opts.blksize) ackOpts.blksize = blksize;
  if (opts.tsize !== undefined) ackOpts.tsize = size;
  if (opts.timeout) ackOpts.timeout = opts.timeout;
  const useOack = Object.keys(ackOpts).length > 0;

  function sendBlock(n) {
    const start = (n - 1) * blksize;
    const chunk = data.subarray(start, start + blksize);
    const pkt = Buffer.alloc(4 + chunk.length);
    pkt.writeUInt16BE(OP.DATA, 0); pkt.writeUInt16BE(n & 0xffff, 2); chunk.copy(pkt, 4);
    try { xs.send(pkt, rinfo.port, rinfo.address); } catch (_) {}
    if (chunk.length < blksize) done = true;
    arm();
  }
  function arm() { clearTimeout(timer); timer = setTimeout(onTimeout, 3000); }
  function onTimeout() {
    if (retries++ > 6) { cleanup('タイムアウト'); return; }
    if (block === 0 && useOack) tftpSendOack(xs, rinfo, ackOpts);
    else if (block >= 1) sendBlock(block);
  }
  function cleanup(reason) {
    clearTimeout(timer); try { xs.close(); } catch (_) {}
    log('tftp', `${reason ? '中断(' + reason + ') ' : '送信完了 '}${filename} → ${who}`, reason ? 'warn' : 'info');
  }
  xs.on('message', (m) => {
    if (m.length < 4) return; const rop = m.readUInt16BE(0);
    if (rop === OP.ERROR) { cleanup('相手側エラー'); return; }
    if (rop !== OP.ACK) return;
    const ackn = m.readUInt16BE(2); retries = 0;
    if (ackn === (block & 0xffff)) {
      if (done) { cleanup(''); return; }
      block++; sendBlock(block);
    }
  });
  if (useOack) { tftpSendOack(xs, rinfo, ackOpts); arm(); } // OACK 後、ACK0 を待ってから block1
  else { block = 1; sendBlock(1); }
}

// クライアント→サーバ（routerの copy run tftp 等＝アップロード）
function tftpServeWrite(xs, rinfo, full, filename, opts, who, conf) {
  if (!conf.writable) { log('tftp', `書込拒否 ${filename} (${who})`, 'warn'); tftpError(xs, rinfo, 2, 'Write not allowed'); return; }
  if (!full) { tftpError(xs, rinfo, 2, 'Illegal path'); return; }
  let fd; try { fs.mkdirSync(path.dirname(full), { recursive: true }); fd = fs.openSync(full, 'w'); }
  catch (e) { tftpError(xs, rinfo, 2, 'Cannot create file'); return; }
  const blksize = tftpNegBlksize(opts);
  let block = 0, total = 0, timer = null, retries = 0, last = -1;
  const ackOpts = {};
  if (opts.blksize) ackOpts.blksize = blksize;
  if (opts.tsize !== undefined) ackOpts.tsize = opts.tsize;
  if (opts.timeout) ackOpts.timeout = opts.timeout;
  const useOack = Object.keys(ackOpts).length > 0;
  log('tftp', `受信開始 ${filename} ← ${who}`);

  let closed = false, dallying = false;
  function ack(n) { const b = Buffer.alloc(4); b.writeUInt16BE(OP.ACK, 0); b.writeUInt16BE(n & 0xffff, 2); try { xs.send(b, rinfo.port, rinfo.address); } catch (_) {} }
  function arm() { clearTimeout(timer); timer = setTimeout(() => { if (retries++ > 6) cleanup('タイムアウト'); else { ack(block); arm(); } }, 3000); }
  function close() { if (closed) return; closed = true; clearTimeout(timer); try { fs.closeSync(fd); } catch (_) {} try { xs.close(); } catch (_) {} }
  function cleanup(reason) {
    clearTimeout(timer);
    log('tftp', `${reason ? '中断(' + reason + ') ' : '受信完了 '}${filename} (${fmtBytes(total)}) ← ${who}`, reason ? 'warn' : 'info');
    if (reason) { close(); return; }
    // 正常終了：最終ACKは既に送出済み。相手の最終DATA再送に備えて少し待ってから閉じる（dallying）
    dallying = true; setTimeout(close, 1200);
  }

  xs.on('message', (m) => {
    if (closed) return;
    if (m.length < 2) return; const rop = m.readUInt16BE(0);
    if (rop === OP.ERROR) { cleanup('相手側エラー'); return; }
    if (rop !== OP.DATA) return;
    const n = m.readUInt16BE(2); retries = 0;
    if (n === ((block + 1) & 0xffff)) {
      const payload = m.subarray(4);
      if (n !== last) { try { fs.writeSync(fd, payload); } catch (_) {} total += payload.length; last = n; }
      block = n; ack(block);
      if (payload.length < blksize) cleanup(''); else arm();
    } else if (n === (block & 0xffff)) { ack(block); if (!dallying) arm(); } // 重複（再送）→ 再ACK
  });
  if (useOack) { tftpSendOack(xs, rinfo, ackOpts); arm(); } // OACK 後にクライアントが block1 を送る
  else { ack(0); arm(); }
}

function startTftp(conf) {
  return new Promise((resolve) => {
    if (tftp) { try { tftp.sock.close(); } catch (_) {} tftp = null; }
    const port = parseInt(conf.port, 10) || 69;
    const sock = dgram.createSocket('udp4');
    let settled = false;
    sock.on('error', (err) => {
      if (tftp && tftp.sock === sock) tftp = null;
      try { sock.close(); } catch (_) {}
      log('tftp', '起動失敗: ' + err.message, 'error');
      if (!settled) { settled = true; resolve({ ok: false, error: err.message }); }
    });
    sock.on('message', (msg, rinfo) => { try { handleTftp(msg, rinfo, conf); } catch (e) { log('tftp', '処理エラー: ' + e.message, 'error'); } });
    try {
      sock.bind(port, () => {
        tftp = { sock, root: conf.root, writable: conf.writable, port };
        log('tftp', `起動 UDP:${port}  公開=${conf.root}  書込=${conf.writable ? '許可' : '禁止'}`);
        settled = true; resolve({ ok: true, port });
      });
    } catch (e) { if (!settled) { settled = true; resolve({ ok: false, error: e.message }); } }
  });
}
function stopTftp() { if (tftp) { try { tftp.sock.close(); } catch (_) {} log('tftp', '停止'); tftp = null; } }

// ---------------------------------------------------------------------------
// HTTP（GET=ダウンロード/ディレクトリ一覧、PUT=アップロード）
// ---------------------------------------------------------------------------
let httpSrv = null;

function dirListingHtml(root, urlPath, entries) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let rows = '';
  if (urlPath !== '/') rows += `<li><a href="../">../</a></li>`;
  for (const e of entries) {
    const slash = e.dir ? '/' : '';
    rows += `<li><a href="${esc(encodeURIComponent(e.name))}${slash}">${esc(e.name)}${slash}</a>${e.dir ? '' : '  <span>' + fmtBytes(e.size) + '</span>'}</li>`;
  }
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>WaTerm HTTP - ${esc(urlPath)}</title>
<style>body{font-family:Segoe UI,Meiryo,sans-serif;background:#1e1e2e;color:#cdd6f4;padding:20px}a{color:#89b4fa;text-decoration:none}a:hover{text-decoration:underline}li{margin:3px 0}span{color:#6c7086;font-size:12px}h2{color:#a6e3a1}</style></head>
<body><h2>📂 ${esc(urlPath)}</h2><ul style="list-style:none;padding:0">${rows}</ul><hr><small>和ターミナル (WaTerm) 内蔵HTTPサーバ</small></body></html>`;
}

function startHttp(conf) {
  return new Promise((resolve) => {
    if (httpSrv) { try { httpSrv.close(); } catch (_) {} httpSrv = null; }
    const port = parseInt(conf.port, 10) || 8080;
    const srv = http.createServer((req, res) => {
      let urlPath; try { urlPath = decodeURIComponent(req.url.split('?')[0]); } catch (_) { urlPath = req.url.split('?')[0]; }
      const full = safeJoin(conf.root, urlPath);
      const who = req.socket.remoteAddress;
      if (!full) { res.writeHead(403); res.end('Forbidden'); return; }
      if (req.method === 'GET' || req.method === 'HEAD') {
        fs.stat(full, (err, st) => {
          if (err) { res.writeHead(404); res.end('Not Found'); log('http', `404 ${urlPath} (${who})`, 'warn'); return; }
          if (st.isDirectory()) {
            fs.readdir(full, { withFileTypes: true }, (e2, items) => {
              if (e2) { res.writeHead(500); res.end('Error'); return; }
              const entries = items.map((it) => { let sz = 0; try { sz = it.isFile() ? fs.statSync(path.join(full, it.name)).size : 0; } catch (_) {} return { name: it.name, dir: it.isDirectory(), size: sz }; });
              const html = dirListingHtml(conf.root, urlPath.endsWith('/') ? urlPath : urlPath + '/', entries);
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html);
            });
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Content-Disposition': 'attachment; filename="' + path.basename(full).replace(/"/g, '') + '"' });
          if (req.method === 'HEAD') { res.end(); return; }
          log('http', `GET ${urlPath} (${fmtBytes(st.size)}) → ${who}`);
          fs.createReadStream(full).on('error', () => { try { res.destroy(); } catch (_) {} }).pipe(res);
        });
      } else if (req.method === 'PUT' || req.method === 'POST') {
        if (!conf.writable) { res.writeHead(403); res.end('Upload disabled'); log('http', `アップロード拒否 ${urlPath} (${who})`, 'warn'); return; }
        try { fs.mkdirSync(path.dirname(full), { recursive: true }); } catch (_) {}
        const ws = fs.createWriteStream(full);
        let n = 0; req.on('data', (d) => n += d.length);
        req.pipe(ws);
        ws.on('finish', () => { res.writeHead(201); res.end('Created'); log('http', `PUT ${urlPath} (${fmtBytes(n)}) ← ${who}`); });
        ws.on('error', () => { res.writeHead(500); res.end('Write error'); });
      } else { res.writeHead(405); res.end('Method Not Allowed'); }
    });
    let settled = false;
    srv.on('error', (err) => { httpSrv = null; log('http', '起動失敗: ' + err.message, 'error'); if (!settled) { settled = true; resolve({ ok: false, error: err.message }); } });
    srv.listen(port, () => { httpSrv = srv; log('http', `起動 TCP:${port}  公開=${conf.root}  アップロード=${conf.writable ? '許可' : '禁止'}`); settled = true; resolve({ ok: true, port }); });
  });
}
function stopHttp() { if (httpSrv) { try { httpSrv.close(); } catch (_) {} log('http', '停止'); httpSrv = null; } }

// ---------------------------------------------------------------------------
// FTP（最小実装：匿名/任意ログイン、PASV/PORT、LIST/NLST/RETR/STOR/CWD/PWD/TYPE/DELE/MKD）
// ---------------------------------------------------------------------------
let ftpSrv = null;

function ftpListLine(name, st) {
  const dir = st.isDirectory();
  const perm = (dir ? 'd' : '-') + 'rw-r--r--';
  const size = st.size;
  const d = st.mtime;
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  const day = String(d.getDate()).padStart(2, ' ');
  const tm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return `${perm} 1 owner group ${String(size).padStart(12)} ${mon} ${day} ${tm} ${name}`;
}

function startFtp(conf) {
  return new Promise((resolve) => {
    if (ftpSrv) { try { ftpSrv.close(); } catch (_) {} ftpSrv = null; }
    const port = parseInt(conf.port, 10) || 21;
    const srv = net.createServer((sock) => {
      const who = sock.remoteAddress + ':' + sock.remotePort;
      let cwd = '/';        // 公開ルート基準の仮想パス
      let type = 'I';
      let pasvServer = null; // PASV データ待受
      let pasvWait = null;   // PASV接続を待つ Promise（接続が先に来ても取りこぼさない）
      let portTarget = null; // PORT 能動モードの宛先
      let pendingRename = null;
      const reply = (code, msg) => { try { sock.write(code + ' ' + msg + '\r\n'); } catch (_) {} };
      const absOf = (vpath) => safeJoin(conf.root, vpath.replace(/^\//, ''));
      const resolveArg = (arg) => {
        if (!arg) return cwd;
        let v = arg.startsWith('/') ? arg : (cwd === '/' ? '/' + arg : cwd + '/' + arg);
        v = path.posix.normalize(v); if (!v.startsWith('/')) v = '/' + v; return v;
      };
      log('ftp', `接続 ${who}`);
      reply(220, '和ターミナル WaTerm FTP ready');

      // データコネクションを確立して cb(dataSocket) を呼ぶ。
      // PASV ではデータ接続がコマンドより先に来ることがあるため、PASV時点で
      // 'connection' を待つ Promise を張っておき、ここではそれを待つ。
      function withData(cb) {
        if (pasvWait) { pasvWait.then((ds) => { if (ds) cb(ds); else reply(425, 'Data connection failed'); }); }
        else if (portTarget) {
          const ds = net.connect(portTarget.port, portTarget.host, () => cb(ds));
          ds.on('error', () => reply(425, 'Cannot open data connection'));
        } else { reply(425, 'Use PASV or PORT first'); }
      }
      function closePasv() { if (pasvServer) { try { pasvServer.close(); } catch (_) {} pasvServer = null; } pasvWait = null; }

      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let nl; while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, ''); buf = buf.slice(nl + 1);
          if (!line) continue;
          const sp = line.indexOf(' ');
          const cmd = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
          const arg = sp < 0 ? '' : line.slice(sp + 1);
          handleCmd(cmd, arg);
        }
      });
      sock.on('error', () => {}); sock.on('close', () => { closePasv(); log('ftp', `切断 ${who}`); });

      function handleCmd(cmd, arg) {
        switch (cmd) {
          case 'USER': reply(331, 'User name okay, need password'); break;
          case 'PASS': reply(230, 'Logged in'); break;
          case 'SYST': reply(215, 'UNIX Type: L8'); break;
          case 'FEAT': try { sock.write('211-Features:\r\n PASV\r\n UTF8\r\n SIZE\r\n211 End\r\n'); } catch (_) {} break;
          case 'OPTS': reply(200, 'OK'); break;
          case 'TYPE': type = arg.toUpperCase().startsWith('A') ? 'A' : 'I'; reply(200, 'Type set to ' + type); break;
          case 'PWD': case 'XPWD': reply(257, '"' + cwd + '" is current directory'); break;
          case 'CWD': case 'XCWD': {
            const v = resolveArg(arg); const abs = absOf(v);
            if (abs && fs.existsSync(abs) && fs.statSync(abs).isDirectory()) { cwd = v; reply(250, 'Directory changed to ' + v); }
            else reply(550, 'No such directory'); break;
          }
          case 'CDUP': case 'XCUP': { cwd = resolveArg('..'); reply(250, 'Directory changed to ' + cwd); break; }
          case 'PASV': {
            closePasv(); portTarget = null;
            pasvServer = net.createServer();
            // データ接続が来たら（コマンドより早くても）socketを保持する Promise
            let resolveConn; pasvWait = new Promise((r) => { resolveConn = r; });
            pasvServer.on('connection', (ds) => { ds.on('error', () => {}); resolveConn(ds); try { pasvServer.close(); } catch (_) {} pasvServer = null; });
            pasvServer.on('error', () => { resolveConn(null); reply(425, 'PASV failed'); });
            pasvServer.listen(0, () => {
              const ap = pasvServer.address();
              const ip = (conf.advertiseIp || '127.0.0.1').split('.').map(Number);
              const p1 = (ap.port >> 8) & 0xff, p2 = ap.port & 0xff;
              reply(227, `Entering Passive Mode (${ip[0]},${ip[1]},${ip[2]},${ip[3]},${p1},${p2})`);
            });
            break;
          }
          case 'PORT': {
            const n = arg.split(',').map((x) => parseInt(x, 10));
            if (n.length === 6) { portTarget = { host: n.slice(0, 4).join('.'), port: (n[4] << 8) + n[5] }; closePasv(); reply(200, 'PORT command successful'); }
            else reply(501, 'Bad PORT'); break;
          }
          case 'LIST': case 'NLST': {
            const v = arg && !arg.startsWith('-') ? resolveArg(arg) : cwd;
            const abs = absOf(v);
            withData((ds) => {
              try {
                const items = fs.readdirSync(abs, { withFileTypes: true });
                let out = '';
                for (const it of items) {
                  if (cmd === 'NLST') out += it.name + '\r\n';
                  else { let st; try { st = fs.statSync(path.join(abs, it.name)); out += ftpListLine(it.name, st) + '\r\n'; } catch (_) {} }
                }
                reply(150, 'Opening data connection');
                ds.end(out, () => reply(226, 'Transfer complete'));
              } catch (e) { try { ds.end(); } catch (_) {} reply(550, 'List failed'); }
              closePasv();
            });
            break;
          }
          case 'RETR': {
            const abs = absOf(resolveArg(arg));
            if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) { reply(550, 'No such file'); break; }
            withData((ds) => {
              reply(150, 'Opening data connection');
              const sz = fs.statSync(abs).size;
              fs.createReadStream(abs).pipe(ds).on('finish', () => { reply(226, 'Transfer complete'); log('ftp', `RETR ${resolveArg(arg)} (${fmtBytes(sz)}) → ${who}`); });
              ds.on('error', () => reply(426, 'Transfer aborted'));
              closePasv();
            });
            break;
          }
          case 'STOR': {
            if (!conf.writable) { reply(550, 'Upload disabled'); break; }
            const abs = absOf(resolveArg(arg));
            if (!abs) { reply(550, 'Illegal path'); break; }
            try { fs.mkdirSync(path.dirname(abs), { recursive: true }); } catch (_) {}
            withData((ds) => {
              reply(150, 'Opening data connection');
              let n = 0; ds.on('data', (d) => n += d.length);
              const ws = fs.createWriteStream(abs);
              ds.pipe(ws);
              ws.on('finish', () => { reply(226, 'Transfer complete'); log('ftp', `STOR ${resolveArg(arg)} (${fmtBytes(n)}) ← ${who}`); });
              ws.on('error', () => reply(451, 'Write error'));
              closePasv();
            });
            break;
          }
          case 'SIZE': { const abs = absOf(resolveArg(arg)); if (abs && fs.existsSync(abs) && fs.statSync(abs).isFile()) reply(213, String(fs.statSync(abs).size)); else reply(550, 'No such file'); break; }
          case 'DELE': { if (!conf.writable) { reply(550, 'Disabled'); break; } const abs = absOf(resolveArg(arg)); try { fs.unlinkSync(abs); reply(250, 'Deleted'); log('ftp', `DELE ${resolveArg(arg)} (${who})`); } catch (_) { reply(550, 'Delete failed'); } break; }
          case 'MKD': case 'XMKD': { if (!conf.writable) { reply(550, 'Disabled'); break; } const abs = absOf(resolveArg(arg)); try { fs.mkdirSync(abs, { recursive: true }); reply(257, '"' + resolveArg(arg) + '" created'); } catch (_) { reply(550, 'Mkdir failed'); } break; }
          case 'RMD': case 'XRMD': { if (!conf.writable) { reply(550, 'Disabled'); break; } const abs = absOf(resolveArg(arg)); try { fs.rmdirSync(abs); reply(250, 'Removed'); } catch (_) { reply(550, 'Rmdir failed'); } break; }
          case 'RNFR': { const abs = absOf(resolveArg(arg)); if (abs && fs.existsSync(abs)) { pendingRename = abs; reply(350, 'Ready for RNTO'); } else reply(550, 'No such file'); break; }
          case 'RNTO': { if (!conf.writable || !pendingRename) { reply(550, 'Disabled'); break; } const abs = absOf(resolveArg(arg)); try { fs.renameSync(pendingRename, abs); pendingRename = null; reply(250, 'Renamed'); } catch (_) { reply(550, 'Rename failed'); } break; }
          case 'NOOP': reply(200, 'OK'); break;
          case 'QUIT': reply(221, 'Goodbye'); try { sock.end(); } catch (_) {} break;
          default: reply(502, 'Command not implemented'); break;
        }
      }
    });
    let settled = false;
    srv.on('error', (err) => { ftpSrv = null; log('ftp', '起動失敗: ' + err.message, 'error'); if (!settled) { settled = true; resolve({ ok: false, error: err.message }); } });
    srv.listen(port, () => { ftpSrv = srv; log('ftp', `起動 TCP:${port}  公開=${conf.root}  書込=${conf.writable ? '許可' : '禁止'}`); settled = true; resolve({ ok: true, port }); });
  });
}
function stopFtp() { if (ftpSrv) { try { ftpSrv.close(); } catch (_) {} log('ftp', '停止'); ftpSrv = null; } }

// ---------------------------------------------------------------------------
function start(proto, conf) {
  if (proto === 'tftp') return startTftp(conf);
  if (proto === 'http') return startHttp(conf);
  if (proto === 'ftp') return startFtp(conf);
  return Promise.resolve({ ok: false, error: '不明なプロトコル' });
}
function stop(proto) {
  if (proto === 'tftp') stopTftp();
  else if (proto === 'http') stopHttp();
  else if (proto === 'ftp') stopFtp();
}
function stopAll() { stopTftp(); stopHttp(); stopFtp(); }
function status() { return { tftp: !!tftp && tftp.port, http: !!httpSrv && httpSrv.address() && httpSrv.address().port, ftp: !!ftpSrv && ftpSrv.address() && ftpSrv.address().port }; }

// ローカルの IPv4 一覧（パネルの「自PCのIP」表示用）
function localIps() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

module.exports = { setLogger, start, stop, stopAll, status, localIps };
