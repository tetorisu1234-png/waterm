'use strict';
// ネットワークスキャン — バックエンド
//   ping sweep / port scan / ARP / SNMP walk をメイン側で実行し、結果を
//   webContents 別に逐次通知する。実装は同梱の netscan.js。
const netscan = require('./netscan');

module.exports = {
  activate(host) {
    const jobs = new Map(); // webContents.id -> 実行中ジョブのキャンセル関数

    // ウィンドウが閉じられたら、そのウィンドウのスキャンを止める
    host.onWindowClosed((wcid) => { const c = jobs.get(wcid); if (c) { try { c(); } catch (_) {} jobs.delete(wcid); } });

    host.handle('netscan:run', (e, { kind, params }) => {
      const wc = e.sender; const wcid = wc.id;
      const prev = jobs.get(wcid); if (prev) { try { prev(); } catch (_) {} jobs.delete(wcid); }
      const ctx = {
        onResult: (row) => host.send(wc, 'netscan:result', { kind, row }),
        onProgress: (p) => host.send(wc, 'netscan:progress', p),
        onEnd: (summary) => { if (jobs.get(wcid) === cancel) jobs.delete(wcid); host.send(wc, 'netscan:end', { kind, summary }); },
      };
      let cancel = () => {};
      try { cancel = netscan.run(kind, params || {}, ctx) || (() => {}); }
      catch (er) { return { ok: false, error: er.message }; }
      jobs.set(wcid, cancel);
      return { ok: true };
    });

    host.on('netscan:stop', (e) => { const c = jobs.get(e.sender.id); if (c) { try { c(); } catch (_) {} jobs.delete(e.sender.id); } });
  },
};
