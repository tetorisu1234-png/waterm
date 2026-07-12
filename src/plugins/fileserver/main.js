'use strict';
// 内蔵ファイルサーバ（TFTP / HTTP / FTP）— バックエンド
//   サーバはアプリ全体で共有のため、ログ・状態は全ウィンドウへブロードキャストする。
const fileserver = require('./fileserver');

module.exports = {
  activate(host) {
    const { dialog, shell, BrowserWindow, app } = host.electron;
    const fs = host.node.fs;

    fileserver.setLogger((entry) => host.broadcastAll('fileserver:log', entry));

    host.handle('fileserver:start', async (e, { proto, conf }) => {
      const c = { ...(conf || {}) };
      if (!c.root) return { ok: false, error: '公開フォルダを選択してください' };
      try { if (!fs.existsSync(c.root) || !fs.statSync(c.root).isDirectory()) return { ok: false, error: '公開フォルダが存在しません' }; }
      catch (_) { return { ok: false, error: '公開フォルダを確認できません' }; }
      const ips = fileserver.localIps();
      c.advertiseIp = c.advertiseIp || (ips[0] && ips[0].address) || '127.0.0.1';
      const r = await fileserver.start(proto, c);
      host.broadcastAll('fileserver:status', fileserver.status());
      return r;
    });
    host.handle('fileserver:stop', (e, { proto }) => { fileserver.stop(proto); host.broadcastAll('fileserver:status', fileserver.status()); return { ok: true }; });
    host.handle('fileserver:status', () => ({ status: fileserver.status(), ips: fileserver.localIps() }));
    host.handle('fileserver:pickDir', async (e) => {
      const w = BrowserWindow.fromWebContents(e.sender);
      const r = await dialog.showOpenDialog(w, { title: '公開フォルダを選択', properties: ['openDirectory'] });
      if (r.canceled || !r.filePaths.length) return { ok: false };
      return { ok: true, dir: r.filePaths[0] };
    });
    host.handle('fileserver:openDir', (e, { dir }) => { try { shell.openPath(dir); return { ok: true }; } catch (er) { return { ok: false, error: er.message }; } });

    // アプリ終了時に全サーバを停止
    app.on('before-quit', () => { try { fileserver.stopAll(); } catch (_) {} });
  },
};
