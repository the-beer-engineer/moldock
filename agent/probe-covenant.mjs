import { PrivateKey, Transaction, Script, P2PKH } from '@bsv/sdk';
import { buildChainLockScript } from './src/genesis.js';
import { getCompiledAsm } from './src/chainBuilder.js';
import { readFileSync } from 'fs';

const env = readFileSync('../.env', 'utf-8');
const pk = PrivateKey.fromWif(env.match(/DISPATCH_PRIVATE_KEY=(\S+)/)[1]);
const addr = pk.toAddress();
const base = 'https://api.whatsonchain.com/v1/bsv/main';

const unspent = await fetch(`${base}/address/${addr}/unspent`).then(r => r.json());
const picked = unspent.sort((a,b) => b.value - a.value)[0];
console.log(`picked: ${picked.tx_hash.slice(0,16)} ${picked.value}`);

const srcHex = await fetch(`${base}/tx/${picked.tx_hash}/hex`).then(r => r.text());
const srcTx = Transaction.fromHex(srcHex);

const compiledAsm = getCompiledAsm(20);
const covenantScript = buildChainLockScript(20, 0, compiledAsm);

const tx = new Transaction();
tx.version = 2;
tx.addInput({
  sourceTransaction: srcTx,
  sourceOutputIndex: picked.tx_pos,
  unlockingScriptTemplate: new P2PKH().unlock(pk, 'all', false, picked.value, new P2PKH().lock(addr)),
});
tx.addOutput({ lockingScript: covenantScript, satoshis: 1 });
tx.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: picked.value - 1000 });
await tx.sign();

console.log(`TX: ${tx.id('hex').slice(0,16)} ${tx.toHex().length/2}B`);

const efHex = tx.toHexEF();
const r = await fetch('https://arcade-eu-1.bsvb.tech/tx', {
  method: 'POST', headers: {'Content-Type':'application/octet-stream'},
  body: Buffer.from(efHex, 'hex')
});
const j = await r.json();
console.log(`Arcade: ${j.txStatus} ${(j.extraInfo||'').slice(0,100)}`);

const wr = await fetch(`${base}/tx/raw`, {
  method: 'POST', headers: {'Content-Type':'application/json'},
  body: JSON.stringify({txhex: tx.toHex()})
});
console.log(`WoC: ${wr.status} ${(await wr.text()).slice(0,100)}`);
