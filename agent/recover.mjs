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
const scriptHash = createHash('sha256').update(Buffer.from(p2pkScript, 'hex')).digest().reverse().toString('hex');

const base = 'https://api.whatsonchain.com/v1/bsv/main';
const p2pkUnspent = await fetch(`${base}/script/${scriptHash}/unspent`).then(r => r.json()).catch(() => []);
const p2pkhUnspent = await fetch(`${base}/address/${addr}/unspent`).then(r => r.json()).catch(() => []);

console.log(`WoC unspent: ${p2pkUnspent.length} P2PK + ${p2pkhUnspent.length} P2PKH`);

const all = [
  ...p2pkUnspent.map(u => ({ txid: u.tx_hash, vout: u.tx_pos, satoshis: u.value, script: p2pkScript })),
  ...p2pkhUnspent.map(u => ({ txid: u.tx_hash, vout: u.tx_pos, satoshis: u.value, script: null })),
];

// Verify each: parent TX exists AND output is unspent
const verified = [];
for (const u of all) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(`${base}/tx/hash/${u.txid}`);
      if (r.status === 429) { await new Promise(rr => setTimeout(rr, 2000)); continue; }
      if (r.status !== 200) { console.log(`  SKIP ${u.txid.slice(0,16)}: HTTP ${r.status}`); break; }
      const d = await r.json();
      const v = d.vout?.[u.vout];
      if (!v) { console.log(`  SKIP ${u.txid.slice(0,16)}: vout missing`); break; }
      if (v.spentTxId) { console.log(`  SKIP ${u.txid.slice(0,16)}: spent in ${v.spentTxId.slice(0,16)}`); break; }

      const hexResp = await fetch(`${base}/tx/${u.txid}/hex`);
      if (!hexResp.ok) break;
      const sourceTxHex = await hexResp.text();
      const sourceTx = Transaction.fromHex(sourceTxHex);
      const actualScript = sourceTx.outputs[u.vout].lockingScript.toHex();
      verified.push({
        txid: u.txid, vout: u.vout, satoshis: u.satoshis,
        script: actualScript, sourceTxHex,
      });
      console.log(`  ✓ ${u.satoshis.toString().padStart(12)} ${u.txid.slice(0,16)}:${u.vout} script=${actualScript.slice(0,10)}`);
      break;
    } catch (e) { console.log(`  ERR ${u.txid.slice(0,16)}: ${e.message}`); break; }
  }
  await new Promise(r => setTimeout(r, 150));
}

const total = verified.reduce((s,u) => s + u.satoshis, 0);
console.log(`\nVerified: ${verified.length} UTXOs, ${total} sats = ${(total/1e8).toFixed(6)} BSV`);

// Write to state file
const stateFile = '/Users/reacher/workspace/projects/moldock/.moldock-state.json';
const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
state.utxos = verified;
writeFileSync(stateFile + '.recovered', JSON.stringify(state));
console.log(`Wrote ${stateFile}.recovered`);
