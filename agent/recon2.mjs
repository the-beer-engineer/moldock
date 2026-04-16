import { readFileSync, writeFileSync } from 'fs';
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

// Fetch confirmed + unconfirmed unspent for BOTH P2PK and P2PKH
async function fetchUnspent() {
  const out = [];
  // P2PK confirmed + unconfirmed
  for (const suffix of ['', '/confirmed', '/unconfirmed']) {
    try {
      const resp = await fetch(`${base}/script/${scriptHash}${suffix}/unspent`);
      if (!resp.ok) continue;
      const data = await resp.json();
      const arr = Array.isArray(data) ? data : (data.result || []);
      for (const u of arr) {
        out.push({ kind: 'p2pk', txid: u.tx_hash, vout: u.tx_pos, satoshis: u.value, script: p2pkHex });
      }
    } catch {}
  }
  // P2PKH
  for (const suffix of ['', '/confirmed', '/unconfirmed']) {
    try {
      const resp = await fetch(`${base}/address/${addr}${suffix}/unspent`);
      if (!resp.ok) continue;
      const data = await resp.json();
      const arr = Array.isArray(data) ? data : (data.result || []);
      for (const u of arr) {
        out.push({ kind: 'p2pkh', txid: u.tx_hash, vout: u.tx_pos, satoshis: u.value, script: '' });
      }
    } catch {}
  }
  // Dedup by txid:vout
  const seen = new Map();
  for (const u of out) {
    const k = `${u.txid}:${u.vout}`;
    if (!seen.has(k)) seen.set(k, u);
  }
  return [...seen.values()];
}

const unspent = await fetchUnspent();
console.log(`[recon] Total unique unspent (confirmed + unconfirmed): ${unspent.length}`);
const sum = unspent.reduce((s, u) => s + u.satoshis, 0);
console.log(`[recon] Total sats: ${sum} = ${(sum/1e8).toFixed(6)} BSV`);

// Fetch source TX hex for each
const persisted = [];
let n = 0;
for (const u of unspent) {
  try {
    const resp = await fetch(`${base}/tx/${u.txid}/hex`);
    if (!resp.ok) { console.log(`  miss ${u.txid.slice(0,8)}: HTTP ${resp.status}`); continue; }
    const sourceTxHex = await resp.text();
    let script = u.script;
    if (!script) {
      const tx = Transaction.fromHex(sourceTxHex);
      script = tx.outputs[u.vout].lockingScript.toHex();
    }
    persisted.push({ txid: u.txid, vout: u.vout, satoshis: u.satoshis, script, sourceTxHex });
    n++;
    if (n % 10 === 0) process.stdout.write(`.`);
  } catch (err) {
    console.log(`  err ${u.txid.slice(0,8)}: ${err.message}`);
  }
  await new Promise(r => setTimeout(r, 30));
}
console.log(`\n[recon] Fetched ${persisted.length} source TXs`);

const totalSats = persisted.reduce((s, u) => s + u.satoshis, 0);
console.log(`[recon] Final: ${persisted.length} UTXOs, ${totalSats} sats = ${(totalSats/1e8).toFixed(6)} BSV`);

// Write new state
const STATE_FILE = '../.moldock-state.json';
const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
state.utxos = persisted;
writeFileSync(STATE_FILE + '.new2', JSON.stringify(state));
console.log(`[recon] Wrote ${STATE_FILE}.new2`);
