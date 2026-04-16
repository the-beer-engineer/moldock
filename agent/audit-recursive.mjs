// Recursive UTXO audit: for every UTXO we think we have, walk back through
// its parent tx chain until we find a tx that ACTUALLY exists on chain.
// Then check if that tx's outputs (that we control) are unspent.
// Output the list of REAL recoverable UTXOs.

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
]).toHex();
const pubKeyHash = createHash('ripemd160').update(createHash('sha256').update(Buffer.from(pubKeyBytes)).digest()).digest('hex');
const p2pkhScript = `76a914${pubKeyHash}88ac`;

const base = 'https://api.whatsonchain.com/v1/bsv/main';

const txExistsCache = new Map();
async function txExists(txid) {
  if (txExistsCache.has(txid)) return txExistsCache.get(txid);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${base}/tx/hash/${txid}`);
      if (r.status === 200) { txExistsCache.set(txid, true); return true; }
      if (r.status === 404) { txExistsCache.set(txid, false); return false; }
      if (r.status === 429) { await new Promise(r => setTimeout(r, 2000)); continue; }
    } catch {}
  }
  return null; // unknown
}

const txHexCache = new Map();
async function getTxHex(txid) {
  if (txHexCache.has(txid)) return txHexCache.get(txid);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${base}/tx/${txid}/hex`);
      if (r.status === 200) {
        const hex = await r.text();
        txHexCache.set(txid, hex);
        return hex;
      }
      if (r.status === 429) { await new Promise(r => setTimeout(r, 2000)); continue; }
      return null;
    } catch {}
  }
  return null;
}

async function checkOutputSpent(txid, vout) {
  try {
    const r = await fetch(`${base}/tx/hash/${txid}`);
    if (!r.ok) return null;
    const d = await r.json();
    const v = d.vout?.[vout];
    if (!v) return null;
    return v.spentTxId || null;
  } catch { return null; }
}

// Start with WoC's view of our unspent
const wocP2PK = await fetch(`${base}/script/${createHash('sha256').update(Buffer.from(p2pkScript, 'hex')).digest().reverse().toString('hex')}/unspent`).then(r => r.json()).catch(() => []);
const wocP2PKH = await fetch(`${base}/address/${addr}/unspent`).then(r => r.json()).catch(() => []);
const wocAll = [
  ...wocP2PK.map(u => ({ ...u, script: p2pkScript })),
  ...wocP2PKH.map(u => ({ ...u, script: p2pkhScript })),
];
console.log(`WoC claims ${wocAll.length} unspent (${wocP2PK.length} P2PK + ${wocP2PKH.length} P2PKH)`);

// For each, verify tx exists AND output is unspent
const real = [];
const phantoms = [];
for (const u of wocAll) {
  const exists = await txExists(u.tx_hash);
  if (exists === true) {
    // Double-check output is unspent
    const spent = await checkOutputSpent(u.tx_hash, u.tx_pos);
    if (spent) {
      phantoms.push({ ...u, reason: `spent in ${spent.slice(0,16)}` });
    } else {
      real.push(u);
    }
  } else {
    phantoms.push({ ...u, reason: 'tx does not exist' });
  }
  await new Promise(r => setTimeout(r, 50));
}

console.log(`\n=== REAL (${real.length}) ===`);
let realTotal = 0;
for (const u of real) {
  console.log(`  ${u.value.toString().padStart(12)} ${u.tx_hash.slice(0,16)}:${u.tx_pos}`);
  realTotal += u.value;
}
console.log(`Real total: ${realTotal} sats = ${(realTotal/1e8).toFixed(6)} BSV`);

console.log(`\n=== PHANTOMS (${phantoms.length}) ===`);
for (const u of phantoms) {
  console.log(`  ${u.value.toString().padStart(12)} ${u.tx_hash.slice(0,16)}:${u.tx_pos} — ${u.reason}`);
}

// Also examine state file — what's in memory right now
const stateFile = '/Users/reacher/workspace/projects/moldock/.moldock-state.json';
try {
  const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
  console.log(`\n=== STATE FILE (${state.utxos?.length || 0} UTXOs) ===`);
  let realInState = 0, phantomInState = 0, stateTotal = 0;
  for (const u of state.utxos || []) {
    stateTotal += u.satoshis;
    const exists = await txExists(u.txid);
    if (exists) realInState++;
    else {
      phantomInState++;
      console.log(`  PHANTOM in state: ${u.satoshis} ${u.txid.slice(0,16)}:${u.vout}`);
    }
    await new Promise(r => setTimeout(r, 30));
  }
  console.log(`State real: ${realInState}, phantom: ${phantomInState}, total: ${stateTotal} sats`);
} catch (e) { console.log(`state file err: ${e.message}`); }
