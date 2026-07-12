'use strict';
// コンフィグ管理（世代保存＋差分）— バックエンド
//   %APPDATA%\waterm\configs\<key>\<ts>.txt に保存。key は機器ごとのフォルダ名。
const path = require('path');
const fs = require('fs');

function sanitizeKey(s) { return String(s || 'device').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\.+$/, '').slice(0, 80) || 'device'; }

module.exports = {
  activate(host) {
    const shell = host.electron.shell;
    const CONFIG_DIR = path.join(host.paths.data, 'configs');

    host.handle('config:save', (e, { key, label, content }) => {
      try {
        const dir = path.join(CONFIG_DIR, sanitizeKey(key));
        fs.mkdirSync(dir, { recursive: true });
        const ts = new Date();
        const pad = (n, w) => String(n).padStart(w || 2, '0');
        const stamp = ts.getFullYear() + pad(ts.getMonth() + 1) + pad(ts.getDate()) + '-' + pad(ts.getHours()) + pad(ts.getMinutes()) + pad(ts.getSeconds());
        const file = stamp + '.txt';
        // 先頭にメタ行（# で始まるのでconfig本文と区別しやすい）。差分時はこの行を除外する。
        const header = `# WaTerm config snapshot\n# device: ${key}\n# label: ${label || ''}\n# saved: ${ts.toLocaleString('ja-JP')}\n`;
        fs.writeFileSync(path.join(dir, file), header + (content || ''), 'utf8');
        return { ok: true, file, dir };
      } catch (er) { return { ok: false, error: er.message }; }
    });
    host.handle('config:listKeys', () => {
      try {
        if (!fs.existsSync(CONFIG_DIR)) return { ok: true, keys: [] };
        const keys = [];
        for (const k of fs.readdirSync(CONFIG_DIR)) {
          const d = path.join(CONFIG_DIR, k);
          try { if (!fs.statSync(d).isDirectory()) continue; const files = fs.readdirSync(d).filter((f) => f.endsWith('.txt')); keys.push({ key: k, count: files.length }); } catch (_) {}
        }
        return { ok: true, keys };
      } catch (er) { return { ok: false, error: er.message }; }
    });
    host.handle('config:list', (e, { key }) => {
      try {
        const dir = path.join(CONFIG_DIR, sanitizeKey(key));
        if (!fs.existsSync(dir)) return { ok: true, snapshots: [] };
        const snaps = fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).map((f) => { const st = fs.statSync(path.join(dir, f)); return { file: f, size: st.size, mtime: st.mtimeMs }; }).sort((a, b) => b.file.localeCompare(a.file));
        return { ok: true, snapshots: snaps };
      } catch (er) { return { ok: false, error: er.message }; }
    });
    host.handle('config:read', (e, { key, file }) => {
      try { const p = path.join(CONFIG_DIR, sanitizeKey(key), path.basename(file)); return { ok: true, content: fs.readFileSync(p, 'utf8') }; }
      catch (er) { return { ok: false, error: er.message }; }
    });
    host.handle('config:delete', (e, { key, file }) => {
      try { fs.unlinkSync(path.join(CONFIG_DIR, sanitizeKey(key), path.basename(file))); return { ok: true }; }
      catch (er) { return { ok: false, error: er.message }; }
    });
    host.handle('config:openDir', (e, { key }) => { try { const d = key ? path.join(CONFIG_DIR, sanitizeKey(key)) : CONFIG_DIR; fs.mkdirSync(d, { recursive: true }); shell.openPath(d); return { ok: true }; } catch (er) { return { ok: false, error: er.message }; } });
  },
};
