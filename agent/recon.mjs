import { readFileSync } from 'fs';
import { PrivateKey, Hash, Utils, LockingScript } from '@bsv/sdk';
import { createHash } from 'crypto';

const env = readFileSync('../.env', 'utf-8');
const wif = env.match(/DISPATCH_PRIVATE_KEY=(\S+)/)[1];
const pk = PrivateKey.fromWif(wif);
const pubKeyBytes = pk.toPublicKey().encode(true);
const addr = pk.toAddress();

const p2pkScript = new LockingScript([
  { op: pubKeyBytes.length, data: pubKeyBytes },
  { op: 0xac }
]);
const p2pkHex = p2pkScript.toHex();
const scriptHashBuf = createHash('sha256').update(Buffer.from(p2pkHex, 'hex')).digest();
const scriptHash = Buffer.from(scriptHashBuf).reverse().toString('hex');

console.log('Address:', addr);

const base = 'https://api.whatsonchain.com/v1/bsv/main';
const p2pkResp = await fetch(`${base}/script/${scriptHash}/unspent`);
const p2pkUtxos = p2pkResp.ok ? await p2pkResp.json() : [];
const p2pkSats = p2pkUtxos.reduce((s, u) => s + u.value, 0);
console.log(`P2PK:  ${p2pkUtxos.length} UTXOs, ${p2pkSats} sats = ${(p2pkSats/1e8).toFixed(6)} BSV`);

const p2pkhResp = await fetch(`${base}/address/${addr}/unspent`);
const p2pkhUtxos = p2pkhResp.ok ? await p2pkhResp.json() : [];
const p2pkhSats = p2pkhUtxos.reduce((s, u) => s + u.value, 0);
console.log(`P2PKH: ${p2pkhUtxos.length} UTXOs, ${p2pkhSats} sats = ${(p2pkhSats/1e8).toFixed(6)} BSV`);

const total = p2pkSats + p2pkhSats;
console.log(`TOTAL: ${p2pkUtxos.length + p2pkhUtxos.length} UTXOs, ${total} sats = ${(total/1e8).toFixed(6)} BSV`);
