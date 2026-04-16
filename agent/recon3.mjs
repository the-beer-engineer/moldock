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
const scriptHash = Buffer.from(createHash('sha256').update(Buffer.from(p2pkHex, 'hex')).digest()).reverse().toString('hex');

const base = 'https://api.whatsonchain.com/v1/bsv/main';

async function fetchJson(url, retries = 6) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      if (r.status === 429 || r.status >= 500) {
        await new Promise(res => setTimeout(res, 1000 * (i + 1)));
        continue;
      }
      return null;
    } catch {
      await new Promise(res => setTimeout(res, 500 * (i + 1)));
    }
  }
  return null;
}

async function fetchText(url, retries = 6) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.text();
      if (r.status === 429 || r.status >= 500) {
        await new Promise(res => setTimeout(res, 1000 * (i + 1)));
        continue;
      }
      return null;
    } catch {
      await new Promise(res => setTimeout(res, 500 * (i + 1)));
    }
  }
  return null;
}

const seenKeys = new Set();
const collected = [];

async function collectUnspent(suffix, kind, script) {
  const urls = [
    kind === 'p2pk' ? `${base}/script/${scriptHash}${suffix}/unspent` : `${base}/address/${addr}${suffix}/unspent`,
  ];
  for (const url of urls) {
    const data = await fetchJson(url);
    if (!data) continue;
    const arr = Array.isArray(data) ? data : (data.result || []);
    for (const u of arr) {
      const key = `${u.tx_hash}:${u.tx_pos}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      collected.push({ txid: u.tx_hash, vout: u.tx_pos, satoshis: u.value, script, kind });
    }
  }
}

console.log(`[recon] Fetching unspent (confirmed + unconfirmed, P2PK + P2PKH)...`);
for (const suffix of ['', '/confirmed', '/unconfirmed']) {
  await collectUnspent(suffix, 'p2pk', p2pkHex);
  await collectUnspent(suffix, 'p2pkh', '');
  await new Promise(r => setTimeout(r, 200));
}

const sum = collected.reduce((s, u) => s + u.satoshis, 0);
console.log(`[recon] Unique unspent: ${collected.length} UTXOs = ${(sum/1e8).toFixed(6)} BSV`);

// Fetch source TX hex for each — cache by txid
const txCache = new Map();
const persisted = [];
let successCount = 0, failCount = 0;
for (const u of collected) {
  let hex = txCache.get(u.txid);
  if (!hex) {
    hex = await fetchText(`${base}/tx/${u.txid}/hex`);
    if (hex) txCache.set(u.txid, hex);
    await new Promise(r => setTimeout(r, 100));
  }
  if (!hex) { failCount++; continue; }
  let script = u.script;
  if (!script) {
    const tx = Transaction.fromHex(hex);
    script = tx.outputs[u.vout].lockingScript.toHex();
  }
  persisted.push({
    txid: u.txid, vout: u.vout, satoshis: u.satoshis, script, sourceTxHex: hex,
  });
  successCount++;
  if (successCount % 10 === 0) process.stdout.write(`.`);
}

const totalSats = persisted.reduce((s, u) => s + u.satoshis, 0);
console.log(`\n[recon] Success: ${successCount}, Failed: ${failCount}`);
console.log(`[recon] Final: ${persisted.length} UTXOs, ${totalSats} sats = ${(totalSats/1e8).toFixed(6)} BSV`);

if (failCount === 0) {
  const STATE_FILE = '../.moldock-state.json';
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  state.utxos = persisted;
  writeFileSync(STATE_FILE + '.recon', JSON.stringify(state));
  console.log(`[recon] ✓ Complete — wrote ${STATE_FILE}.recon`);
} else {
  console.log(`[recon] ⚠ Incomplete due to ${failCount} fetch failures — NOT writing state`);
}
