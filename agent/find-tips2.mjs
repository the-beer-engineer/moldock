import { readFileSync } from 'fs';
import { PrivateKey } from '@bsv/sdk';
const env = readFileSync('../.env', 'utf-8');
const pk = PrivateKey.fromWif(env.match(/DISPATCH_PRIVATE_KEY=(\S+)/)[1]);
const addr = pk.toAddress();
const base = 'https://api.whatsonchain.com/v1/bsv/main';

async function fetchJson(url, retries=5) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      if (r.status === 429 || r.status >= 500) { await new Promise(r=>setTimeout(r,2000*(i+1))); continue; }
      return null;
    } catch { await new Promise(r=>setTimeout(r,1000)); }
  }
  return null;
}

const unspent = await fetchJson(`${base}/address/${addr}/unspent`);
if (!unspent) { console.log('WoC rate limit'); process.exit(1); }
console.log(`Starting: ${unspent.length} UTXOs`);

const tips = [];
for (const u of unspent) {
  let txid = u.tx_hash, vout = u.tx_pos, depth = 0;
  while (depth < 50) {
    const d = await fetchJson(`${base}/tx/hash/${txid}`);
    if (!d) break;
    const v = d.vout?.[vout];
    if (!v) break;
    if (!v.spentTxId) {
      tips.push({ txid, vout, sats: Math.round(v.value*1e8), depth, conf: d.confirmations||0 });
      if (depth > 0) console.log(`  ${u.tx_hash.slice(0,12)} → depth ${depth} → TIP ${txid.slice(0,12)}:${vout} ${Math.round(v.value*1e8)} sats`);
      break;
    }
    const sd = await fetchJson(`${base}/tx/hash/${v.spentTxId}`);
    if (!sd) break;
    let found = false;
    for (let i = 0; i < sd.vout.length; i++) {
      if ((sd.vout[i].scriptPubKey?.addresses||[]).includes(addr) && sd.vout[i].value > 0.0001) {
        txid = v.spentTxId; vout = i; found = true; break;
      }
    }
    if (!found) break;
    depth++;
    await new Promise(r=>setTimeout(r,150));
  }
  await new Promise(r=>setTimeout(r,300));
}

// Dedup tips by txid:vout
const seen = new Set();
const unique = tips.filter(t => { const k=`${t.txid}:${t.vout}`; if(seen.has(k)) return false; seen.add(k); return true; });
console.log(`\n=== ${unique.length} TIPS ===`);
let total = 0;
for (const t of unique) {
  console.log(`  ${t.sats.toString().padStart(12)} ${t.txid.slice(0,16)}:${t.vout} depth=${t.depth} conf=${t.conf}`);
  total += t.sats;
}
console.log(`Total: ${(total/1e8).toFixed(6)} BSV`);
