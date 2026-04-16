// Walk the spending chain from each UTXO to find the current tip (latest unspent)
import { readFileSync } from 'fs';
import { PrivateKey } from '@bsv/sdk';
const env = readFileSync('../.env', 'utf-8');
const pk = PrivateKey.fromWif(env.match(/DISPATCH_PRIVATE_KEY=(\S+)/)[1]);
const addr = pk.toAddress();
const base = 'https://api.whatsonchain.com/v1/bsv/main';

const unspent = await fetch(`${base}/address/${addr}/unspent`).then(r => r.json());
console.log(`Starting with ${unspent.length} UTXOs from WoC:`);

// For each, walk the chain: if output is spent, follow the spending TX
let tips = [];
for (const u of unspent) {
  let txid = u.tx_hash;
  let vout = u.tx_pos;
  let value = u.value;
  let depth = 0;
  
  while (true) {
    const r = await fetch(`${base}/tx/hash/${txid}`);
    if (!r.ok) { console.log(`  ${txid.slice(0,16)} — tx not found`); break; }
    const d = await r.json();
    const v = d.vout?.[vout];
    if (!v) { console.log(`  ${txid.slice(0,16)} — vout ${vout} not found`); break; }
    
    if (!v.spentTxId) {
      // This is the TIP — output is unspent
      tips.push({ txid, vout, value: Math.round(v.value * 1e8), depth, height: d.confirmations > 0 ? d.blockheight : 0 });
      console.log(`  TIP at depth ${depth}: ${txid.slice(0,16)}:${vout} = ${Math.round(v.value*1e8)} sats (conf=${d.confirmations || 0})`);
      break;
    }
    
    // Follow the spending TX — find OUR output in it
    const spendTxid = v.spentTxId;
    depth++;
    if (depth > 50) { console.log(`  chain too deep!`); break; }
    
    // Get the spending TX
    const sr = await fetch(`${base}/tx/hash/${spendTxid}`);
    if (!sr.ok) { console.log(`  spending TX ${spendTxid.slice(0,16)} not found — TIP here`); tips.push({ txid, vout, value: Math.round(v.value*1e8), depth }); break; }
    const sd = await sr.json();
    
    // Find our output in the spending TX (look for our address)
    let found = false;
    for (let i = 0; i < sd.vout.length; i++) {
      const sv = sd.vout[i];
      const addrs = sv.scriptPubKey?.addresses || [];
      if (addrs.includes(addr) && sv.value > 0.0001) {
        txid = spendTxid;
        vout = i;
        value = Math.round(sv.value * 1e8);
        found = true;
        break;
      }
    }
    if (!found) { console.log(`  no output to us in ${spendTxid.slice(0,16)} — chain ended`); break; }
    await new Promise(r => setTimeout(r, 100));
  }
  await new Promise(r => setTimeout(r, 200));
}

console.log(`\n=== ${tips.length} TIPS (latest unspent) ===`);
let total = 0;
for (const t of tips) {
  console.log(`  ${t.value.toString().padStart(12)} ${t.txid.slice(0,16)}:${t.vout} depth=${t.depth}`);
  total += t.value;
}
console.log(`Total: ${total} sats = ${(total/1e8).toFixed(6)} BSV`);
