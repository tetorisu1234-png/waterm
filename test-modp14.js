'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const MODP = JSON.parse(fs.readFileSync(path.join(__dirname, 'src', 'modp-primes.json'), 'utf8'));
const g = MODP.modp14;
const a = crypto.createDiffieHellman(Buffer.from(g.prime, 'hex'), Buffer.from(g.gen, 'hex'));
const b = crypto.createDiffieHellman(Buffer.from(g.prime, 'hex'), Buffer.from(g.gen, 'hex'));
const ak = a.generateKeys(), bk = b.generateKeys();
const ok = a.computeSecret(bk).equals(b.computeSecret(ak));
fs.appendFileSync('E:\\WaTerm\\m14.txt', 'modp14 single-use match=' + ok + '\n');
