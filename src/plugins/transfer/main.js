'use strict';
// ファイル転送（XMODEM / YMODEM / ZMODEM / Kermit）— バックエンド
//   受信バイトは host.onConnConsumeRx で横取りし、転送プロトコルへ流す。
//   相手の sz/sb 実行（ZRQINIT）を host.onConnData で検知し自動受信を促す。
const transfer = require('./transfer');

const PROTO_LABEL = { xmodem: 'XMODEM', xmodem1k: 'XMODEM-1K', ymodem: 'YMODEM', zmodem: 'ZMODEM', kermit: 'Kermit' };
const MULTIFILE = { ymodem: true, zmodem: true, kermit: true }; // ファイル名/複数ファイルを扱うプロトコル
const ZRQINIT_MARK = Buffer.from([0x2a, 0x2a, 0x18]); // "**" + ZDLE = ZMODEMヘッダの先頭

module.exports = {
  activate(host) {
    const { dialog, app } = host.electron;
    const { fs, path } = host.node;
    const conns = host.conns;

    // 転送中は受信生バイトを横取り（本体の端末描画を止める）
    host.onConnConsumeRx(({ entry, buf }) => {
      if (entry && entry.xfer) { try { entry.xfer.onData(buf); } catch (_) {} return true; }
      return false;
    });
    // ZMODEMオートスタート検知（未転送時に ZRQINIT を見たらレンダラへ通知）
    host.onConnData(({ id, dir, buf, entry, isEcho }) => {
      if (dir !== 'rx' || isEcho || !entry || entry.xfer) return;
      if (entry.autoZmodem === false || entry.zAutoPending) return;
      if (buf && buf.includes(ZRQINIT_MARK)) {
        entry.zAutoPending = true;
        setTimeout(() => { const en = conns.get(id); if (en) en.zAutoPending = false; }, 5000); // 連続検出のクールダウン
        host.send(entry.wc, 'transfer:autostart', { id, proto: 'zmodem' });
      }
    });

    host.handle('transfer:start', async (e, { id, proto, dir }) => {
      const en = conns.get(id);
      if (!en) return { ok: false, error: '接続がありません' };
      if (en.type === 'rdp') return { ok: false, error: 'この接続では使えません' };
      if (en.xfer) return { ok: false, error: '転送が進行中です' };
      if (!PROTO_LABEL[proto]) return { ok: false, error: '未対応のプロトコルです' };
      const wc = e.sender;
      const mainWin = host.getMainWindow();
      const termMsg = (m, color) => host.send(wc, 'conn:data', { id, data: '\r\n\x1b[' + (color || '36') + 'm[転送] ' + m + '\x1b[0m\r\n' });
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
        // ⚠ 元 main.js の transfer:start は files/saveFile を startTransfer へ渡し忘れていた
        //   （transfer.js は opts.files / opts.saveFile を使う）。移設時に正しく渡すよう修正。
        proto, dir, files, saveFile,
        send: (bytes) => host.writeRaw(id, bytes),
        log: (m) => termMsg(m),
        progress: (p) => {
          const cur = p.sent != null ? p.sent : p.received; const tot = p.total;
          const pct = tot ? Math.floor(cur / tot * 100) : null;
          if (pct !== null && pct !== lastPct) { lastPct = pct; host.send(wc, 'conn:data', { id, data: '\r\x1b[36m[転送] ' + (p.name || '') + ' ' + pct + '% (' + cur + '/' + tot + ')\x1b[0m' }); }
        },
        done: (r) => { en.xfer = null; if (r && r.ok) termMsg('すべて完了しました', 32); else termMsg('失敗: ' + ((r && r.error) || '不明なエラー'), 31); host.send(wc, 'transfer:done', { id, result: r }); },
      });
      termMsg(PROTO_LABEL[proto] + ' ' + (dir === 'send' ? '送信' : '受信') + 'を開始しました。相手側で対応コマンド（例: sx/sb/sz, rx/rb/rz）を実行してください', 33);
      return { ok: true, started: true };
    });
    host.on('transfer:abort', (e, { id }) => { const en = conns.get(id); if (en && en.xfer) { try { en.xfer.abort(); } catch (_) {} } });
  },
};
