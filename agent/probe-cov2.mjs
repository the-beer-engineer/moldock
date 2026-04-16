import { readFileSync } from 'fs';
import { PrivateKey, Transaction, Script, SatoshisPerKilobyte, P2PKH } from '@bsv/sdk';

const env = readFileSync('../.env', 'utf-8');
const wif = env.match(/DISPATCH_PRIVATE_KEY=(\S+)/)[1];
const pk = PrivateKey.fromWif(wif);
const addr = pk.toAddress();

const base = 'https://api.whatsonchain.com/v1/bsv/main';
const unspent = await fetch(`${base}/address/${addr}/unspent`).then(r => r.json());
const picked = unspent.sort((a,b) => b.value - a.value)[0];
const srcHex = await fetch(`${base}/tx/${picked.tx_hash}/hex`).then(r => r.text());
const srcTx = Transaction.fromHex(srcHex);

async function build(outputType) {
  const tx = new Transaction();
  tx.version = 2;
  tx.addInput({
    sourceTransaction: srcTx,
    sourceOutputIndex: picked.tx_pos,
    unlockingScriptTemplate: new P2PKH().unlock(pk, 'all', false, picked.value, new P2PKH().lock(addr)),
  });
  if (outputType === 'p2pkh') {
    tx.addOutput({ lockingScript: new P2PKH().lock(addr), change: true });
  } else if (outputType === 'small_covenant') {
    tx.addOutput({ lockingScript: Script.fromHex('04010203047500'), satoshis: 1 });
    tx.addOutput({ lockingScript: new P2PKH().lock(addr), change: true });
  }
  await tx.fee(new SatoshisPerKilobyte(500));
  await tx.sign();
  return tx;
}

async function broadcast(tx, label) {
  const efHex = tx.toHexEF();
  const r = await fetch('https://arcade-eu-1.bsvb.tech/tx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from(efHex, 'hex'),
  });
  const txt = await r.text();
  console.log(`${label} HTTP ${r.status}:`);
  console.log(`  ${txt.slice(0, 400)}`);
}

const tx1 = await build('p2pkh');
console.log(`P2PKH tx: ${tx1.id('hex')} ${tx1.toHex().length/2}B`);
await broadcast(tx1, 'P2PKH → P2PKH');

const tx2 = await build('small_covenant');
console.log(`COV tx: ${tx2.id('hex')} ${tx2.toHex().length/2}B`);
await broadcast(tx2, 'P2PKH → small covenant + P2PKH');
