// For each P2PKH UTXO on chain, check if its output is actually spendable
// or if there's a DIFFERENT tx in mempool already spending it
import { readFileSync } from 'fs';
import { PrivateKey, Transaction, P2PKH } from '@bsv/sdk';

const env = readFileSync('../.env', 'utf-8');
const wif = env.match(/DISPATCH_PRIVATE_KEY=(\S+)/)[1];
const pk = PrivateKey.fromWif(wif);
const addr = pk.toAddress();

const base = 'https://api.whatsonchain.com/v1/bsv/main';
const unspent = await fetch(`${base}/address/${addr}/unspent`).then(r => r.json());
console.log(`WoC says ${unspent.length} P2PKH unspent:`);

for (const u of unspent.sort((a,b) => -a.value + b.value)) {
  console.log(`\n  ${u.value.toString().padStart(12)} ${u.tx_hash.slice(0,16)}:${u.tx_pos}`);
  
  // Check if parent tx exists on WoC
  const wocR = await fetch(`${base}/tx/hash/${u.tx_hash}`);
  const wocStatus = wocR.status;
  
  // Check Arcade
  const arcR = await fetch(`https://arcade-eu-1.bsvb.tech/tx/${u.tx_hash}`);
  const arcJ = await arcR.json();
  
  console.log(`    WoC /tx/hash: ${wocStatus}`);
  console.log(`    Arcade /tx: ${arcJ.txStatus || arcJ.error || 'unknown'}`);
  
  if (wocR.ok) {
    const d = await wocR.json();
    console.log(`    confirmations: ${d.confirmations}`);
    const v = d.vout[u.tx_pos];
    console.log(`    spentTxId: ${v?.spentTxId || 'null (UNSPENT)'}`);
  }
  
  // Now try to BUILD a tx spending it and see what WoC says
  if (u.value > 1000) {
    try {
      const srcHex = await fetch(`${base}/tx/${u.tx_hash}/hex`).then(r => r.text());
      const srcTx = Transaction.fromHex(srcHex);
      const tx = new Transaction();
      tx.version = 2;
      tx.addInput({
        sourceTransaction: srcTx,
        sourceOutputIndex: u.tx_pos,
        unlockingScriptTemplate: new P2PKH().unlock(pk, 'all', false, u.value, new P2PKH().lock(addr)),
      });
      tx.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: u.value - 500 });
      await tx.sign();
      
      // Try WoC broadcast
      const wocBroadcast = await fetch(`${base}/tx/raw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txhex: tx.toHex() }),
      });
      const wocBroadcastTxt = await wocBroadcast.text();
      console.log(`    WoC broadcast: ${wocBroadcast.status} ${wocBroadcastTxt.slice(0, 200)}`);
    } catch (e) {
      console.log(`    build err: ${e.message}`);
    }
  }
  
  await new Promise(r => setTimeout(r, 200));
}
