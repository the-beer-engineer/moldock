// Simplest test: P2PKH → P2PKH with unique nonce
import { readFileSync } from 'fs';
import { PrivateKey, Transaction, Script, SatoshisPerKilobyte, P2PKH } from '@bsv/sdk';

const env = readFileSync('../.env', 'utf-8');
const wif = env.match(/DISPATCH_PRIVATE_KEY=(\S+)/)[1];
const pk = PrivateKey.fromWif(wif);
const addr = pk.toAddress();

const base = 'https://api.whatsonchain.com/v1/bsv/main';
const unspent = await fetch(`${base}/address/${addr}/unspent`).then(r => r.json());
console.log(`unspent: ${unspent.length}`);
const picked = unspent.sort((a,b) => b.value - a.value)[0];
console.log(`picked ${picked.tx_hash.slice(0,16)}:${picked.tx_pos} value=${picked.value}`);

const srcHex = await fetch(`${base}/tx/${picked.tx_hash}/hex`).then(r => r.text());
const srcTx = Transaction.fromHex(srcHex);

const tx = new Transaction();
tx.version = 2;
tx.addInput({
  sourceTransaction: srcTx,
  sourceOutputIndex: picked.tx_pos,
  unlockingScriptTemplate: new P2PKH().unlock(pk, 'all', false, picked.value, new P2PKH().lock(addr)),
});
const nonce = Date.now().toString(16);
tx.addOutput({ lockingScript: Script.fromHex(`006a08${nonce}`), satoshis: 0 });
tx.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: picked.value - 200 });
await tx.sign();
console.log(`tx: ${tx.id('hex')} ${tx.toHex().length/2}B`);

const efHex = tx.toHexEF();
const r = await fetch('https://arcade-eu-1.bsvb.tech/tx', {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: Buffer.from(efHex, 'hex'),
});
const j = await r.json();
console.log(`result: ${j.txStatus}${j.extraInfo ? ' — ' + j.extraInfo.slice(0,200) : ''}${j.error ? ' — ' + j.error : ''}`);
