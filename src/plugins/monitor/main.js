'use strict';
// 通信モニタ / パケットキャプチャ — バックエンド
//   セッション送受信は host.onConnData で観測して記録（en.monitor が有効な接続のみ）。
//   pcap 保存は同梱 pcap.js、NICキャプチャは Wireshark の tshark を利用。
const pcap = require('./pcap');

const MON_MAX_FRAMES = 20000, MON_MAX_BYTES = 16 * 1024 * 1024;

module.exports = {
  activate(host) {
    const { dialog, BrowserWindow, app } = host.electron;
    const { fs, path, cp, spawn } = host.node;
    const conns = host.conns;

    // 送受信バイトの記録（記録ONの接続のみ）。rx の端末エコーは記録しない。
    host.onConnData(({ id, dir, buf, entry, isEcho }) => {
      if (!entry || !entry.monitor || !buf || !buf.length) return;
      if (dir === 'rx' && isEcho) return;
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      const ts = Date.now();
      if (!entry.monitorLog) { entry.monitorLog = []; entry.monitorBytes = 0; }
      entry.monitorLog.push({ dir, ts, bytes: b });
      entry.monitorBytes += b.length;
      while (entry.monitorLog.length > MON_MAX_FRAMES || entry.monitorBytes > MON_MAX_BYTES) {
        const old = entry.monitorLog.shift(); if (!old) break; entry.monitorBytes -= old.bytes.length;
      }
      host.send(entry.wc, 'monitor:data', { id, dir, ts, len: b.length, b64: b.toString('base64') });
    });

    // --- セッション通信モニタ ---
    host.handle('monitor:toggle', (e, { id, on }) => {
      const en = conns.get(id); if (!en) return { ok: false, error: '接続がありません' };
      en.monitor = !!on;
      if (on && !en.monitorLog) { en.monitorLog = []; en.monitorBytes = 0; }
      return { ok: true, on: en.monitor, frames: en.monitorLog ? en.monitorLog.length : 0 };
    });
    host.handle('monitor:state', (e, { id }) => {
      const en = conns.get(id); if (!en) return { ok: false };
      return { ok: true, on: !!en.monitor, frames: en.monitorLog ? en.monitorLog.length : 0, bytes: en.monitorBytes || 0 };
    });
    host.handle('monitor:clear', (e, { id }) => { const en = conns.get(id); if (en) { en.monitorLog = []; en.monitorBytes = 0; } return { ok: true }; });
    host.handle('monitor:export', async (e, { id }) => {
      const en = conns.get(id); if (!en || !en.monitorLog || !en.monitorLog.length) return { ok: false, error: '記録がありません' };
      const win = BrowserWindow.fromWebContents(e.sender) || host.getMainWindow();
      const r = await dialog.showSaveDialog(win, { title: '通信モニタを pcap で保存', defaultPath: path.join(app.getPath('documents'), 'waterm-capture.pcap'), filters: [{ name: 'pcap', extensions: ['pcap'] }] });
      if (r.canceled || !r.filePath) return { ok: false };
      try {
        const buf = pcap.buildPcap(en.monitorLog, { remoteIp: en.host, remotePort: en.port });
        fs.writeFileSync(r.filePath, buf);
        return { ok: true, path: r.filePath, frames: en.monitorLog.length };
      } catch (er) { return { ok: false, error: er.message }; }
    });

    // --- パケットキャプチャ（Wireshark の tshark） ---
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
    host.onWindowClosed((wcid) => { const p = captureProcs.get(wcid); if (p) { try { p.kill(); } catch (_) {} captureProcs.delete(wcid); } });

    host.handle('capture:tshark', () => ({ path: findTshark() }));
    host.handle('capture:interfaces', async () => {
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
    host.handle('capture:start', (e, { iface, filter }) => {
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
          host.send(e.sender, 'capture:packet', { no: f[0], time: f[1], src: f[2], dst: f[3], proto: f[4], len: f[5], info: f[6] || '' });
        }
      });
      let errBuf = '';
      proc.stderr.on('data', (d) => { errBuf += d.toString('utf8'); });
      proc.on('close', (code) => { captureProcs.delete(wcid); host.send(e.sender, 'capture:end', { code, error: code ? errBuf.trim() : '' }); });
      proc.on('error', (er) => { captureProcs.delete(wcid); host.send(e.sender, 'capture:end', { code: -1, error: er.message }); });
      return { ok: true };
    });
    host.on('capture:stop', (e) => { const p = captureProcs.get(e.sender.id); if (p) { try { p.kill(); } catch (_) {} captureProcs.delete(e.sender.id); } });
  },
};
