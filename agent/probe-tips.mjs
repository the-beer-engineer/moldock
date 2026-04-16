import { readFileSync } from 'fs';
import { PrivateKey, Transaction, Script, P2PKH } from '@bsv/sdk';
const env = readFileSync('../.env', 'utf-8');
const pk = PrivateKey.fromWif(env.match(/DISPATCH_PRIVATE_KEY=(\S+)/)[1]);
const addr = pk.toAddress();
const base = 'https://api.whatsonchain.com/v1/bsv/main';

// Try to spend each of the 2 big confirmed tips
const tips = [
  { txid: 'c0e166737dc037c287e2f13c5dcb4b0fbca3aa23e46f29fd53a08f9c2e2a4a10', vout: 20, value: 63033045 },
  { txid: '9c83d183a363958a8e04fdd14e4670f94e462bf8a8e7cd3f14a5ab3cfcfaab7e', vout: 1, value: 226393437 },
];

for (const tip of tips) {
  console.log(`\n=== ${tip.txid.slice(0,16)}:${tip.vout} ${tip.value} sats ===`);
  let srcHex;
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${base}/tx/${tip.txid}/hex`);
    if (r.ok) { srcHex = await r.text(); break; }
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!srcHex) { console.log('  failed to fetch'); continue; }
  
  const srcTx = Transaction.fromHex(srcHex);
  const tx = new Transaction();
  tx.version = 2;
  tx.addInput({
    sourceTransaction: srcTx,
    sourceOutputIndex: tip.vout,
    unlockingScriptTemplate: new P2PKH().unlock(pk, 'all', false, tip.value, new P2PKH().lock(addr)),
  });
  tx.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: tip.value - 500 });
  await tx.sign();
  
  // Try ALL Arcade endpoints + WoC
  const efHex = tx.toHexEF();
  for (const ep of ['arcade-eu-1', 'arcade-ttn-us-1', 'arcade-us-1']) {
    const r = await fetch(`https://${ep}.bsvb.tech/tx`, {
      method: 'POST', headers: {'Content-Type':'application/octet-stream'},
      body: Buffer.from(efHex, 'hex')
    });
    const j = await r.json();
    console.log(`  ${ep}: ${j.txStatus || 'X'} ${(j.extraInfo||j.error||'').slice(0,80)}`);
  }
  const wr = await fetch(`${base}/tx/raw`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({txhex: tx.toHex()})
  });
  console.log(`  WoC: ${wr.status} ${(await wr.text()).slice(0,100)}`);
  
  await new Promise(r => setTimeout(r, 500));
}
