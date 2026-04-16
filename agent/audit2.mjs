// Output-level audit: for each state file UTXO, check vout.spentTxId
import { readFileSync, writeFileSync } from 'fs';
import { PrivateKey, LockingScript, Transaction } from '@bsv/sdk';
import { createHash } from 'crypto';

const env = readFileSync('../.env', 'utf-8');
const wif = env.match(/DISPATCH_PRIVATE_KEY=(\S+)/)[1];
const pk = PrivateKey.fromWif(wif);
const addr = pk.toAddress();
const base = 'https://api.whatsonchain.com/v1/bsv/main';

async function checkOutput(txid, vout) {
  // Returns: 'unspent', 'spent', '404', 'err'
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(`${base}/tx/hash/${txid}`);
      if (r.status === 404) return '404';
      if (r.status === 429) { await new Promise(rr => setTimeout(rr, 2000)); continue; }
      if (!r.ok) return 'err';
      const d = await r.json();
      const v = d.vout?.[vout];
      if (!v) return 'err';
      return v.spentTxId ? 'spent' : 'unspent';
    } catch {}
  }
  return 'err';
}

const state = JSON.parse(readFileSync('/Users/reacher/workspace/projects/moldock/.moldock-state.json', 'utf-8'));
console.log(`State has ${state.utxos.length} UTXOs, total ${state.utxos.reduce((s,u)=>s+u.satoshis,0)/1e8} BSV`);

const real = [];
const spent = [];
const missing = [];

for (const u of state.utxos) {
  const status = await checkOutput(u.txid, u.vout);
  if (status === 'unspent') real.push(u);
  else if (status === 'spent') spent.push(u);
  else if (status === '404') missing.push(u);
  process.stdout.write(`.`);
  await new Promise(r => setTimeout(r, 100));
}
console.log();
console.log(`\nREAL unspent: ${real.length} totaling ${real.reduce((s,u)=>s+u.satoshis,0)/1e8} BSV`);
console.log(`SPENT (ghosts): ${spent.length} totaling ${spent.reduce((s,u)=>s+u.satoshis,0)/1e8} BSV`);
console.log(`MISSING tx (ghosts): ${missing.length} totaling ${missing.reduce((s,u)=>s+u.satoshis,0)/1e8} BSV`);

// Write cleaned state file
if (real.length > 0) {
  state.utxos = real;
  writeFileSync('/Users/reacher/workspace/projects/moldock/.moldock-state.json.audit', JSON.stringify(state));
  console.log(`\nWrote cleaned state to .moldock-state.json.audit`);
}
