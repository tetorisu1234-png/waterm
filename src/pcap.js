'use strict';
// ---------------------------------------------------------------------------
// 通信モニタのフレーム列を .pcap (classic, LINKTYPE_ETHERNET) に変換
//   - 各フレームを Ethernet + IPv4 + TCP でラップし、方向ごとに seq を進める
//   - Wireshark で「Follow TCP Stream」可能な、整合した擬似ストリームを生成する
//   frames: [{ dir:'tx'|'rx', ts:msEpoch, bytes:Buffer }]
//   opts:   { remoteIp, remotePort, localIp, localPort }
// ---------------------------------------------------------------------------
function parseIp(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s || ''));
  if (!m) return null;
  const o = [+m[1], +m[2], +m[3], +m[4]];
  if (o.some((x) => x > 255)) return null;
  return o;
}
function checksum16(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 2) sum += (buf[i] << 8) | (buf[i + 1] || 0);
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return (~sum) & 0xffff;
}

function buildPcap(frames, opts) {
  opts = opts || {};
  const remoteIp = parseIp(opts.remoteIp) || [10, 0, 0, 2];
  const localIp = parseIp(opts.localIp) || [10, 0, 0, 1];
  const remotePort = (opts.remotePort | 0) || 9;
  const localPort = (opts.localPort | 0) || 50000;
  const localMac = Buffer.from([0x02, 0, 0, 0, 0, 1]);
  const remoteMac = Buffer.from([0x02, 0, 0, 0, 0, 2]);

  const chunks = [];
  const gh = Buffer.alloc(24);
  gh.writeUInt32LE(0xa1b2c3d4, 0);   // magic
  gh.writeUInt16LE(2, 4); gh.writeUInt16LE(4, 6); // version 2.4
  gh.writeInt32LE(0, 8); gh.writeUInt32LE(0, 12);
  gh.writeUInt32LE(65535, 16); gh.writeUInt32LE(1, 20); // snaplen / Ethernet
  chunks.push(gh);

  let seqTx = 1, seqRx = 1;
  for (const f of frames) {
    const payload = Buffer.isBuffer(f.bytes) ? f.bytes : Buffer.from(f.bytes || []);
    const tx = f.dir === 'tx';
    const srcIp = tx ? localIp : remoteIp, dstIp = tx ? remoteIp : localIp;
    const srcPort = tx ? localPort : remotePort, dstPort = tx ? remotePort : localPort;
    const srcMac = tx ? localMac : remoteMac, dstMac = tx ? remoteMac : localMac;
    let seq, ack;
    if (tx) { seq = seqTx; ack = seqRx; seqTx = (seqTx + payload.length) >>> 0; }
    else { seq = seqRx; ack = seqTx; seqRx = (seqRx + payload.length) >>> 0; }

    const eth = Buffer.alloc(14); dstMac.copy(eth, 0); srcMac.copy(eth, 6); eth.writeUInt16BE(0x0800, 12);
    const ip = Buffer.alloc(20);
    ip[0] = 0x45; ip[1] = 0; ip.writeUInt16BE(40 + payload.length, 2);
    ip.writeUInt16BE(0, 4); ip.writeUInt16BE(0x4000, 6); ip[8] = 64; ip[9] = 6; ip.writeUInt16BE(0, 10);
    ip[12] = srcIp[0]; ip[13] = srcIp[1]; ip[14] = srcIp[2]; ip[15] = srcIp[3];
    ip[16] = dstIp[0]; ip[17] = dstIp[1]; ip[18] = dstIp[2]; ip[19] = dstIp[3];
    ip.writeUInt16BE(checksum16(ip), 10);

    const tcp = Buffer.alloc(20);
    tcp.writeUInt16BE(srcPort, 0); tcp.writeUInt16BE(dstPort, 2);
    tcp.writeUInt32BE(seq >>> 0, 4); tcp.writeUInt32BE(ack >>> 0, 8);
    tcp[12] = 0x50; tcp[13] = 0x18; tcp.writeUInt16BE(65535, 14); // PSH,ACK
    const pseudo = Buffer.alloc(12);
    pseudo[0] = srcIp[0]; pseudo[1] = srcIp[1]; pseudo[2] = srcIp[2]; pseudo[3] = srcIp[3];
    pseudo[4] = dstIp[0]; pseudo[5] = dstIp[1]; pseudo[6] = dstIp[2]; pseudo[7] = dstIp[3];
    pseudo[8] = 0; pseudo[9] = 6; pseudo.writeUInt16BE(20 + payload.length, 10);
    tcp.writeUInt16BE(checksum16(Buffer.concat([pseudo, tcp, payload])), 16);

    const pkt = Buffer.concat([eth, ip, tcp, payload]);
    const ms = Math.max(0, Math.floor(f.ts || 0));
    const rec = Buffer.alloc(16);
    rec.writeUInt32LE(Math.floor(ms / 1000), 0);
    rec.writeUInt32LE((ms % 1000) * 1000, 4);
    rec.writeUInt32LE(pkt.length, 8); rec.writeUInt32LE(pkt.length, 12);
    chunks.push(rec, pkt);
  }
  return Buffer.concat(chunks);
}

module.exports = { buildPcap, parseIp };
