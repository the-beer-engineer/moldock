import { readFileSync } from 'fs';
import { PrivateKey, Transaction, Script, SatoshisPerKilobyte, P2PKH } from '@bsv/sdk';

const env = readFileSync('../.env', 'utf-8');
const wif = env.match(/DISPATCH_PRIVATE_KEY=(\S+)/)[1];
const pk = PrivateKey.fromWif(wif);
const addr = pk.toAddress();

const base = 'https://api.whatsonchain.com/v1/bsv/main';
const unspent = await fetch(`${base}/address/${addr}/unspent`).then(r => r.json());
let idx = 0;

// Use 10 DIFFERENT unique UTXOs, send simple P2PKH-only with unique OP_RETURN
for (let i = 0; i < 6; i++) {
  const picked = unspent.sort((a,b) => b.value - a.value)[idx++];
  if (!picked) break;
  const srcHex = await fetch(`${base}/tx/${picked.tx_hash}/hex`).then(r => r.text());
  const srcTx = Transaction.fromHex(srcHex);
  const tx = new Transaction();
  tx.version = 2;
  tx.addInput({
    sourceTransaction: srcTx,
    sourceOutputIndex: picked.tx_pos,
    unlockingScriptTemplate: new P2PKH().unlock(pk, 'all', false, picked.value, new P2PKH().lock(addr)),
  });
  // Unique nonce
  const nonce = (Date.now() + i).toString(16).padStart(16, '0');
  tx.addOutput({ lockingScript: Script.fromHex(`006a08${nonce}`), satoshis: 0 });
  tx.addOutput({ lockingScript: new P2PKH().lock(addr), change: true });
  await tx.fee(new SatoshisPerKilobyte(500));
  await tx.sign();

  const efHex = tx.toHexEF();
  const r = await fetch('https://arcade-eu-1.bsvb.tech/tx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from(efHex, 'hex'),
  });
  const j = await r.json();
  console.log(`${i+1}. ${tx.id('hex').slice(0,16)}: ${j.txStatus || 'X'} ${(j.extraInfo || j.error || '').slice(0, 100)}`);
  await new Promise(r => setTimeout(r, 500));
}
