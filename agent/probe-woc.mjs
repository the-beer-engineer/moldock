import { readFileSync } from 'fs';
import { PrivateKey, Transaction, Script, P2PKH } from '@bsv/sdk';
const env = readFileSync('../.env', 'utf-8');
const wif = env.match(/DISPATCH_PRIVATE_KEY=(\S+)/)[1];
const pk = PrivateKey.fromWif(wif);
const addr = pk.toAddress();
const base = 'https://api.whatsonchain.com/v1/bsv/main';
const unspent = await fetch(`${base}/address/${addr}/unspent`).then(r => r.json());
for (const u of unspent.sort((a,b) => b.value - a.value).slice(0, 3)) {
  if (u.value < 100) continue;
  console.log(`\n=== ${u.tx_hash.slice(0,16)}:${u.tx_pos} ${u.value} sats ===`);
  const srcHex = await fetch(`${base}/tx/${u.tx_hash}/hex`).then(r => r.text());
  const srcTx = Transaction.fromHex(srcHex);
  const tx = new Transaction();
  tx.version = 2;
  tx.addInput({ sourceTransaction: srcTx, sourceOutputIndex: u.tx_pos, unlockingScriptTemplate: new P2PKH().unlock(pk, 'all', false, u.value, new P2PKH().lock(addr)) });
  const nonce = (Date.now() + u.tx_pos).toString(16).padStart(16, '0');
  tx.addOutput({ lockingScript: Script.fromHex(`006a08${nonce}`), satoshis: 0 });
  tx.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: u.value - 500 });
  await tx.sign();
  // Try WoC broadcast
  const r = await fetch(`${base}/tx/raw`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({txhex: tx.toHex()}) });
  console.log(`  WoC: ${r.status} ${(await r.text()).slice(0,200)}`);
  await new Promise(r => setTimeout(r, 200));
}
