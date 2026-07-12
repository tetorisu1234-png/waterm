'use strict';
// ネットワーク診断（ローカル ping / tracert / nslookup）— バックエンド
//   自分のPCから対象ホストへコマンドを実行し出力を逐次流す。出力は日本語
//   Windows のコンソール文字コード(CP932)なので iconv で復号する。
module.exports = {
  activate(host) {
    const spawn = host.node.spawn;
    const iconv = host.node.iconv;
    const diagProcs = new Map(); // webContents.id -> child process（1ウィンドウ1実行）

    host.onWindowClosed((wcid) => { const c = diagProcs.get(wcid); if (c) { try { c.kill(); } catch (_) {} diagProcs.delete(wcid); } });

    host.handle('diag:run', (e, { kind, host: target, count }) => {
      const h = String(target || '').trim();
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
      child.stdout.on('data', (b) => host.send(e.sender, 'diag:data', { text: dec(b) }));
      child.stderr.on('data', (b) => host.send(e.sender, 'diag:data', { text: dec(b) }));
      child.on('error', (er) => { if (diagProcs.get(wcid) === child) diagProcs.delete(wcid); host.send(e.sender, 'diag:end', { code: -1, error: er.message }); });
      child.on('close', (code) => { if (diagProcs.get(wcid) === child) diagProcs.delete(wcid); host.send(e.sender, 'diag:end', { code }); });
      return { ok: true, cmd: cmd + ' ' + args.join(' ') };
    });
    host.on('diag:stop', (e) => { const c = diagProcs.get(e.sender.id); if (c) { try { c.kill(); } catch (_) {} diagProcs.delete(e.sender.id); } });
  },
};
