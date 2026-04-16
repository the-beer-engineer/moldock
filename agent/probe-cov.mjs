// Test if covenant output is the issue by trying a P2PKH → P2PKH consolidation
// plus a test with a simple OP_RETURN output
import { readFileSync } from 'fs';
import { PrivateKey, Transaction, Script, SatoshisPerKilobyte, P2PKH } from '@bsv/sdk';

const env = readFileSync('../.env', 'utf-8');
const wif = env.match(/DISPATCH_PRIVATE_KEY=(\S+)/)[1];
const pk = PrivateKey.fromWif(wif);
const addr = pk.toAddress();

const base = 'https://api.whatsonchain.com/v1/bsv/main';
const unspent = await fetch(`${base}/address/${addr}/unspent`).then(r => r.json());
console.log(`P2PKH unspent: ${unspent.length}`);
if (unspent.length === 0) { console.log('no UTXOs'); process.exit(0); }

const picked = unspent.sort((a,b) => b.value - a.value)[0];
console.log(`picked: ${picked.tx_hash.slice(0,16)}:${picked.tx_pos} value=${picked.value}`);

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
  } else if (outputType === 'op_return') {
    tx.addOutput({ lockingScript: Script.fromHex('006a0a48656c6c6f576f726c64'), satoshis: 0 });
    tx.addOutput({ lockingScript: new P2PKH().lock(addr), change: true });
  } else if (outputType === 'small_covenant') {
    // Simple "OP_DROP" covenant — just a dummy push + drop
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
  const j = await r.json();
  console.log(`${label}: ${j.txStatus}${j.extraInfo ? ' — ' + j.extraInfo.slice(0, 120) : ''}`);
}

await broadcast(await build('p2pkh'), 'P2PKH → P2PKH');
await broadcast(await build('op_return'), 'P2PKH → OP_RETURN + P2PKH');
await broadcast(await build('small_covenant'), 'P2PKH → small covenant + P2PKH');
