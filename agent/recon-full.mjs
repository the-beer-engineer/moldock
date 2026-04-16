import { readFileSync } from 'fs';
import { PrivateKey, LockingScript, Transaction } from '@bsv/sdk';
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

const base = 'https://api.whatsonchain.com/v1/bsv/main';
console.log(`Address: ${addr}`);
console.log(`P2PK script hash: ${scriptHash}`);

// 1. Current unspent via WoC
const [p2pkUnspent, p2pkhUnspent] = await Promise.all([
  fetch(`${base}/script/${scriptHash}/unspent`).then(r => r.json()).catch(() => []),
  fetch(`${base}/address/${addr}/unspent`).then(r => r.json()).catch(() => []),
]);
const p2pkUnspentSats = p2pkUnspent.reduce((s, u) => s + u.value, 0);
const p2pkhUnspentSats = Array.isArray(p2pkhUnspent) ? p2pkhUnspent.reduce((s, u) => s + u.value, 0) : 0;
console.log(`\n--- CONFIRMED UNSPENT (WoC) ---`);
console.log(`P2PK:  ${p2pkUnspent.length} UTXOs, ${p2pkUnspentSats} sats = ${(p2pkUnspentSats/1e8).toFixed(6)} BSV`);
console.log(`P2PKH: ${Array.isArray(p2pkhUnspent) ? p2pkhUnspent.length : 0} UTXOs, ${p2pkhUnspentSats} sats = ${(p2pkhUnspentSats/1e8).toFixed(6)} BSV`);

// 2. P2PK history — all TXs involving this script
const p2pkHist = await fetch(`${base}/script/${scriptHash}/history`).then(r => r.json()).catch(() => []);
console.log(`\n--- P2PK HISTORY ---`);
console.log(`Total history TXs: ${Array.isArray(p2pkHist) ? p2pkHist.length : 0}`);

// 3. P2PKH history
const p2pkhHist = await fetch(`${base}/address/${addr}/history`).then(r => r.json()).catch(() => []);
console.log(`\n--- P2PKH HISTORY ---`);
console.log(`Total history TXs: ${Array.isArray(p2pkhHist) ? p2pkhHist.length : 0}`);

// 4. Address mempool-only unspent
try {
  const mempool = await fetch(`${base}/address/${addr}/confirmed/unspent`).then(r => r.json()).catch(() => []);
  console.log(`\nP2PKH confirmed-only unspent: ${Array.isArray(mempool) ? mempool.length : 0}`);
} catch {}

// 5. Check mempool state via P2PK script (if endpoint exists)
try {
  const mpU = await fetch(`${base}/script/${scriptHash}/unconfirmed/unspent`).then(r => r.json()).catch(() => null);
  if (mpU) console.log(`\nP2PK unconfirmed-only: ${JSON.stringify(mpU).slice(0, 200)}`);
} catch {}

// 6. Sum ALL outputs in history paying this script (ignoring whether spent)
//    Lots of API calls — only do if <200 history
if (Array.isArray(p2pkHist) && p2pkHist.length > 0 && p2pkHist.length < 500) {
  console.log(`\n--- AUDITING ${p2pkHist.length} HISTORY TXs ---`);
  let totalPaidIn = 0, totalOut = 0, parsed = 0;
  for (let i = 0; i < p2pkHist.length; i++) {
    const txid = p2pkHist[i].tx_hash;
    try {
      const hex = await fetch(`${base}/tx/${txid}/hex`).then(r => r.text());
      const tx = Transaction.fromHex(hex);
      // Count outputs paying our P2PK
      for (const o of tx.outputs) {
        if (o.lockingScript?.toHex() === p2pkHex) {
          totalPaidIn += o.satoshis ?? 0;
        }
      }
      parsed++;
    } catch (err) {
      // skip
    }
    if (i % 10 === 0) process.stdout.write(`.`);
  }
  console.log(`\nParsed: ${parsed}/${p2pkHist.length}`);
  console.log(`Total paid IN to P2PK (ever): ${totalPaidIn} sats = ${(totalPaidIn/1e8).toFixed(6)} BSV`);
}
