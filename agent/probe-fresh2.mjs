import { readFileSync } from 'fs';
import { PrivateKey, Transaction, Script, SatoshisPerKilobyte, P2PKH } from '@bsv/sdk';

const env = readFileSync('../.env', 'utf-8');
const wif = env.match(/DISPATCH_PRIVATE_KEY=(\S+)/)[1];
const pk = PrivateKey.fromWif(wif);
const addr = pk.toAddress();

const base = 'https://api.whatsonchain.com/v1/bsv/main';
const unspent = await fetch(`${base}/address/${addr}/unspent`).then(r => r.json());
// Pick DIFFERENT UTXO per test to avoid conflicts
let idx = 0;

async function build(label, outputs) {
  const picked = unspent.sort((a,b) => b.value - a.value)[idx++];
  if (!picked) return null;
  const srcHex = await fetch(`${base}/tx/${picked.tx_hash}/hex`).then(r => r.text());
  const srcTx = Transaction.fromHex(srcHex);
  const tx = new Transaction();
  tx.version = 2;
  tx.addInput({
    sourceTransaction: srcTx,
    sourceOutputIndex: picked.tx_pos,
    unlockingScriptTemplate: new P2PKH().unlock(pk, 'all', false, picked.value, new P2PKH().lock(addr)),
  });
  for (const o of outputs) tx.addOutput(o);
  tx.addOutput({ lockingScript: new P2PKH().lock(addr), change: true });
  await tx.fee(new SatoshisPerKilobyte(500));
  await tx.sign();
  return tx;
}

async function test(tx, label) {
  if (!tx) { console.log(`${label}: NO UTXO`); return; }
  const efHex = tx.toHexEF();
  // Try 3 times for SQLITE_BUSY
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch('https://arcade-eu-1.bsvb.tech/tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: Buffer.from(efHex, 'hex'),
      });
      const j = await r.json();
      if (j.error && /database is locked/i.test(j.error) && attempt < 2) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      console.log(`${label}: ${j.txStatus || 'UNKNOWN'}${j.extraInfo ? ' — ' + j.extraInfo.slice(0,140) : ''}${j.error && !j.txStatus ? ' — ' + j.error.slice(0,140) : ''}`);
      return;
    } catch (e) { console.log(`${label}: ${e.message}`); return; }
  }
}

await test(await build('1', []), '1. P2PKH only');
await test(await build('2', [{ lockingScript: Script.fromHex('006a0568656c6c6f'), satoshis: 0 }]), '2. OP_RETURN data');
// Small non-standard: single byte push + OP_DROP + OP_TRUE
await test(await build('3', [{ lockingScript: Script.fromHex('0100755100'), satoshis: 1 }]), '3. Custom: push 1 byte/drop/true');
// 33-byte push + drop + true
await test(await build('4', [{ lockingScript: Script.fromHex('21' + '00'.repeat(33) + '755100'), satoshis: 1 }]), '4. Custom: push 33b/drop/true');
// PUSHDATA2 with 100 bytes
await test(await build('5', [{ lockingScript: Script.fromHex('4d' + '6400' + 'aa'.repeat(100) + '755100'), satoshis: 1 }]), '5. Custom: PUSHDATA2 100b/drop/true');
