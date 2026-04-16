import { readFileSync } from 'fs';
import { PrivateKey, Transaction, Script, SatoshisPerKilobyte, P2PKH } from '@bsv/sdk';

const env = readFileSync('../.env', 'utf-8');
const wif = env.match(/DISPATCH_PRIVATE_KEY=(\S+)/)[1];
const pk = PrivateKey.fromWif(wif);
const addr = pk.toAddress();

const base = 'https://api.whatsonchain.com/v1/bsv/main';
const unspent = await fetch(`${base}/address/${addr}/unspent`).then(r => r.json());
const nonce = Date.now().toString(16).padStart(12, '0'); // 6 bytes
let idx = 0;

async function build(label, extraOutputs) {
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
  for (const o of extraOutputs) tx.addOutput(o);
  // Unique OP_RETURN to make txid unique
  tx.addOutput({ lockingScript: Script.fromHex(`006a06${nonce}`), satoshis: 0 });
  tx.addOutput({ lockingScript: new P2PKH().lock(addr), change: true });
  await tx.fee(new SatoshisPerKilobyte(500));
  await tx.sign();
  return tx;
}

async function test(tx, label) {
  if (!tx) { console.log(`${label}: NO UTXO`); return; }
  const efHex = tx.toHexEF();
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

// All fresh (with nonce), all testing different script patterns
await test(await build('a', []), 'a. P2PKH+nonce (baseline)');
await test(await build('b', [{ lockingScript: Script.fromHex('006a'), satoshis: 0 }]), 'b. + empty OP_RETURN');
await test(await build('c', [{ lockingScript: Script.fromHex('0100755100'), satoshis: 1 }]), 'c. + push1/drop/true');
await test(await build('d', [{ lockingScript: Script.fromHex('21' + '00'.repeat(33) + '755100'), satoshis: 1 }]), 'd. + push33/drop/true');
// Now simulate a small chain lock: big data push + OP_DROP + OP_DROP + OP_CHECKSIG pattern
await test(await build('e', [{ lockingScript: Script.fromHex('4c80' + 'aa'.repeat(128) + '755100'), satoshis: 1 }]), 'e. + PUSHDATA1 128b/drop/true');
