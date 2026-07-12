'use strict';
// ===========================================================================
// プラグインホスト（メインプロセス側） — 「フォルダが正」＋「単一ファイル管理」
//   プラグイン置き場: <userData>/plugins/ 。ここには **プラグイン本体のみ** を置く:
//     (A) フォルダ  <id>/plugin.json + main.js/renderer.js ...
//     (B) 単一ファイル <name>.wtp / <name>.zip（中身は標準 ZIP）
//   管理用データ（seed 状態・アーカイブ展開キャッシュ）は plugins/ を汚さないよう
//   別の内部フォルダ <userData>/plugins-cache/ に置く（ユーザーは通常触らない）。
//   同梱プラグイン(src/plugins) は seed 専用で、起動時 syncBundled() が各々を
//   1 つの <id>.wtp に固めて plugins/ へ書き出す（＝各プラグイン 1 ファイル）。
//   アーカイブは prepareArchives() が内部キャッシュへ展開し、実体フォルダとして
//   backend require / file:// 資産に使う。同一 ID は「手置きフォルダ ＞ アーカイブ」。
//   version(整数) 印で同梱側が新しければ自動更新。ユーザー削除は復活させない。
//   backend の同梱 node_modules 解決は main.js の NODE_PATH 追加で担保。
// ===========================================================================
const fs = require('fs');
const path = require('path');
const archive = require('./plugin-archive');

const BUILTIN_DIR = path.join(__dirname, 'plugins'); // 同梱の雛形（seed 元）
const STATE_FILE = 'seed-state.json';                // 内部: seed 状態
const STAMP_FILE = 'stamps.json';                    // 内部: アーカイブ展開の差分印
const ARCHIVE_EXTS = new Set(['.wtp', '.zip']);      // 単一ファイルとして扱う拡張子
// 旧版で plugins/ 直下に置いていた管理データ（掃除・移行対象）
const LEGACY_STATE = '.seed-state.json';
const LEGACY_CACHE = '.cache';

// BOM を除去して JSON を解釈（Windows 製 plugin.json は UTF-8 BOM 付きが多い）
function parseJson(bufOrStr) {
  let s = Buffer.isBuffer(bufOrStr) ? bufOrStr.toString('utf8') : String(bufOrStr);
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  return JSON.parse(s);
}
function readJsonFile(file, fallback) {
  try { return parseJson(fs.readFileSync(file)); } catch (_) { return fallback; }
}

function metaToRec(meta, id, dir) {
  return {
    id,
    name: meta.name || id,
    description: meta.description || '',
    core: !!meta.core,
    version: Number(meta.version) || 0,
    backend: meta.backend || null,
    renderer: meta.renderer || null,
    panel: meta.panel || null,
    style: meta.style || null,
    dir,
  };
}

// 1ディレクトリ直下のプラグイン（plugin.json を持つサブフォルダ）を走査
function scanDir(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name === LEGACY_CACHE) continue; // 旧キャッシュ（移行前の掃除まで存在し得る）
    const pdir = path.join(dir, ent.name);
    let meta;
    try { meta = parseJson(fs.readFileSync(path.join(pdir, 'plugin.json'))); }
    catch (_) { continue; }
    out.push(metaToRec(meta, meta.id || ent.name, pdir));
  }
  return out;
}

// ---- アーカイブ（単一ファイル）補助 ----

// フォルダ配下の全ファイルを [{name(相対,/区切り), data:Buffer}] で読む
function readDirFiles(root) {
  const out = [];
  (function walk(cur, rel) {
    let ents = [];
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of ents) {
      const abs = path.join(cur, ent.name);
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(abs, r);
      else out.push({ name: r, data: fs.readFileSync(abs) });
    }
  })(root, '');
  return out;
}

// フォルダを 1 つの zip Buffer へ固める
function packFolder(dir) { return archive.zipWrite(readDirFiles(dir)); }

// アーカイブ内から plugin.json を探し {meta, entries, prefix} を返す。
//   Explorer/PS 等でフォルダごと圧縮された場合の先頭ディレクトリ接頭辞も判定。
function inspectArchive(buf) {
  const entries = archive.zipRead(buf);
  let best = null;
  for (const e of entries) {
    if (e.dir) continue;
    if (e.name.split('/').pop() === 'plugin.json') {
      const depth = e.name.split('/').length;
      if (!best || depth < best.depth) best = { name: e.name, depth, data: e.data };
    }
  }
  if (!best) throw new Error('plugin.json が見つかりません');
  const meta = parseJson(best.data);
  const prefix = best.name.includes('/') ? best.name.slice(0, best.name.lastIndexOf('/') + 1) : '';
  return { meta, entries, prefix };
}

// アーカイブを destDir へ展開（接頭辞を剥がして配置）
function extractArchive(buf, destDir) {
  const { entries, prefix } = inspectArchive(buf);
  try { fs.rmSync(destDir, { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(destDir, { recursive: true });
  const root = path.resolve(destDir) + path.sep;
  for (const e of entries) {
    if (e.dir) continue;
    if (prefix && !e.name.startsWith(prefix)) continue;
    const rel = prefix ? e.name.slice(prefix.length) : e.name;
    if (!rel) continue;
    // パストラバーサル防止: 展開先を超えるパス（.. / 絶対 / ドライブ文字）は破棄
    const abs = path.resolve(destDir, rel);
    if (abs !== path.resolve(destDir) && !abs.startsWith(root)) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, e.data);
  }
}

// 旧版が plugins/ 直下に置いていた管理データ(.seed-state.json/.cache)を掃除する。
//   状態は呼び出し側で先に移行済みの前提。
function cleanLegacy(userDir) {
  if (!userDir) return;
  try { fs.rmSync(path.join(userDir, LEGACY_STATE), { force: true }); } catch (_) {}
  try { fs.rmSync(path.join(userDir, LEGACY_CACHE), { recursive: true, force: true }); } catch (_) {}
}

// <userDir> のアーカイブ(.wtp/.zip)を <cacheDir>/<id>/ へ展開する。
//   変更（サイズ/更新時刻）があった時だけ再展開し、消えたアーカイブの残骸は掃除。
function prepareArchives(userDir, cacheDir) {
  if (!userDir || !cacheDir) return;
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (_) {}
  const stampFile = path.join(cacheDir, STAMP_FILE);
  const stamps = readJsonFile(stampFile, {}) || {};

  let files = [];
  try { files = fs.readdirSync(userDir, { withFileTypes: true }); } catch (_) {}
  const newStamps = {};
  const activeIds = new Set();
  for (const ent of files) {
    if (!ent.isFile()) continue;
    if (!ARCHIVE_EXTS.has(path.extname(ent.name).toLowerCase())) continue;
    const full = path.join(userDir, ent.name);
    let st, buf;
    try { st = fs.statSync(full); buf = fs.readFileSync(full); } catch (_) { continue; }
    const sig = st.size + ':' + Math.floor(st.mtimeMs);
    let meta;
    try { meta = inspectArchive(buf).meta; }
    catch (e) { console.error('[plugin] アーカイブ読取失敗:', ent.name, e.message); continue; }
    const id = meta.id || path.basename(ent.name, path.extname(ent.name));
    const dest = path.join(cacheDir, id);
    const prev = stamps[ent.name];
    if (!(prev && prev.sig === sig && prev.id === id && fs.existsSync(dest))) {
      try { extractArchive(buf, dest); }
      catch (e) { console.error('[plugin] 展開失敗:', ent.name, e.message); continue; }
    }
    newStamps[ent.name] = { sig, id };
    activeIds.add(id);
  }
  // 元アーカイブが消えた展開キャッシュを削除
  let cached = [];
  try { cached = fs.readdirSync(cacheDir, { withFileTypes: true }); } catch (_) {}
  for (const ent of cached) {
    if (!ent.isDirectory()) continue;
    if (!activeIds.has(ent.name)) { try { fs.rmSync(path.join(cacheDir, ent.name), { recursive: true, force: true }); } catch (_) {} }
  }
  try { fs.writeFileSync(stampFile, JSON.stringify(newStamps, null, 2)); } catch (_) {}
}

// 同梱プラグインを <userDir>/<id>.wtp（単一ファイル）へ seed / バージョン同期。
//   状態は <cacheDir>/seed-state.json に保存（plugins/ を汚さない）。
//   旧版でフォルダ seed 済みなら、その内容を .wtp に固めてから移行する。
function syncBundled(userDir, cacheDir) {
  if (!userDir || !cacheDir) return { versions: {}, deleted: [] };
  try { fs.mkdirSync(userDir, { recursive: true }); } catch (_) {}
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (_) {}
  const stateFile = path.join(cacheDir, STATE_FILE);
  // 状態の読取。無ければ旧 plugins/.seed-state.json から移行
  let state = readJsonFile(stateFile, null);
  if (!state) state = readJsonFile(path.join(userDir, LEGACY_STATE), {}) || {};
  if (!state.versions || typeof state.versions !== 'object') state.versions = {};
  if (!Array.isArray(state.deleted)) state.deleted = [];

  for (const p of scanDir(BUILTIN_DIR)) {
    const wtp = path.join(userDir, p.id + '.wtp');
    const folder = path.join(userDir, p.id);
    const seededVer = state.versions[p.id]; // 数値 or undefined

    // 旧版のフォルダ seed を単一ファイルへ移行（編集内容は保持）
    if (!fs.existsSync(wtp) && seededVer !== undefined) {
      let isDir = false; try { isDir = fs.statSync(folder).isDirectory(); } catch (_) {}
      if (isDir) {
        try { fs.writeFileSync(wtp, packFolder(folder)); fs.rmSync(folder, { recursive: true, force: true }); } catch (_) {}
      }
    }

    const exists = fs.existsSync(wtp);
    const write = () => { try { fs.writeFileSync(wtp, packFolder(p.dir)); } catch (e) { console.error('[plugin] seed 書込失敗:', p.id, e.message); } };

    if (p.core) {
      if (!exists || (seededVer || 0) < p.version) { write(); state.versions[p.id] = p.version; }
      const di = state.deleted.indexOf(p.id); if (di >= 0) state.deleted.splice(di, 1);
      continue;
    }

    if (!exists) {
      if (seededVer !== undefined) {
        // seed 済みなのに無い＝ユーザー削除 → 尊重して復活させない
        if (!state.deleted.includes(p.id)) state.deleted.push(p.id);
        delete state.versions[p.id];
      } else if (!state.deleted.includes(p.id)) {
        write(); state.versions[p.id] = p.version; // 初回 seed
      }
    } else {
      const di = state.deleted.indexOf(p.id); if (di >= 0) state.deleted.splice(di, 1);
      if (seededVer === undefined) state.versions[p.id] = p.version;       // 既存採用
      else if (seededVer < p.version) { write(); state.versions[p.id] = p.version; } // 同梱が新しい→更新
    }
  }

  try { fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); } catch (_) {}
  cleanLegacy(userDir); // 旧 plugins/.seed-state.json / .cache を掃除
  return state;
}

// 有効/表示対象のプラグイン一覧。手置きフォルダを優先、次に展開済みアーカイブ。
//   builtin=同梱由来 / archived=単一ファイル由来（バッジ表示用）。
function discover(userDir, cacheDir) {
  const bundledIds = new Set(scanDir(BUILTIN_DIR).map((p) => p.id));
  const out = [];
  const seen = new Set();
  for (const p of scanDir(userDir)) {                       // (A) 手置きフォルダ（優先）
    if (seen.has(p.id)) continue; seen.add(p.id);
    out.push(Object.assign({}, p, { builtin: bundledIds.has(p.id), archived: false }));
  }
  if (cacheDir) {
    for (const p of scanDir(cacheDir)) {                    // (B) 展開済みアーカイブ
      if (seen.has(p.id)) continue; seen.add(p.id);
      out.push(Object.assign({}, p, { builtin: bundledIds.has(p.id), archived: true }));
    }
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

// backend を読み込む（有効なもののみ activate）。実体フォルダから require する。
function loadBackends(host, disabled, userDir, cacheDir) {
  const dis = disabled instanceof Set ? disabled : new Set(disabled || []);
  const loaded = [];
  for (const p of discover(userDir, cacheDir)) {
    const enabled = p.core || !dis.has(p.id);
    const rec = { id: p.id, name: p.name, enabled, error: null };
    loaded.push(rec);
    if (!enabled || !p.backend) continue;
    try {
      const mod = require(path.join(p.dir, p.backend));
      if (mod && typeof mod.activate === 'function') mod.activate(host);
    } catch (e) {
      rec.error = e.message;
      console.error('[plugin] backend activate 失敗:', p.id, e);
    }
  }
  return loaded;
}

module.exports = { BUILTIN_DIR, discover, loadBackends, syncBundled, prepareArchives, packFolder, inspectArchive };
