'use strict';
// RDP（リモートデスクトップ）— バックエンド
//   Windows標準の mstsc を .rdp ファイル生成で起動し、その HWND を WaTerm の
//   ウィンドウ内へ再ペアレント（winembed = koffi FFI）。高速描画モード(GPU合成)時は
//   子HWNDが見えないため外部mstscへフォールバックする。
const winembed = require('./winembed');

module.exports = {
  activate(host) {
    const { app, BrowserWindow } = host.electron;
    const { spawn, cp, fs, path } = host.node;
    const conns = host.conns;

    function buildRdpFile(cfg, embedded) {
      const hostAddr = (cfg.host || '').trim();
      if (!hostAddr) throw new Error('ホストが指定されていません');
      const port = Number(cfg.port) || 3389;
      const user = (cfg.domain ? cfg.domain + '\\' : '') + (cfg.username || '');
      const lines = [];
      lines.push('full address:s:' + hostAddr + ':' + port);
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
        // 高速モードはGPU合成が有効で埋め込み(子HWND)が見えないため、外部mstscで開く
        if (host.getPerfMode()) { rdpLaunch(cfg).then((r) => resolve(Object.assign({ embedded: false }, r))); return; }
        const reqWin = BrowserWindow.fromWebContents(wc) || host.getMainWindow(); // 要求元ウィンドウに埋め込む（分離ウィンドウ対応）
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
        proc.on('exit', () => { host.send(wc, 'conn:status', { id, status: 'closed' }); });
        let tries = 0;
        const timer = setInterval(() => {
          tries++;
          let hwnd = null;
          try { hwnd = winembed.findWindowByPid(proc.pid); } catch (_) {}
          if (hwnd) {
            clearInterval(timer);
            entry.hwnd = hwnd;
            winembed.embed(hwnd, entry.parent);
            host.send(wc, 'conn:status', { id, status: 'connected' });
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

    host.handle('rdp:launch', (e, cfg) => rdpLaunch(cfg || {}));
    host.handle('rdp:embed', (e, { id, cfg }) => rdpEmbed(e.sender, id, cfg || {}));
    host.on('rdp:position', (e, { id, rect }) => rdpPosition(id, rect));
    host.on('rdp:show', (e, { id, visible }) => { const en = conns.get(id); if (en && en.type === 'rdp' && en.hwnd) winembed.show(en.hwnd, visible); });
  },
};
