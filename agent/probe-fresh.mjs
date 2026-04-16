// Use a fresh nonce-based output to avoid TX collisions with prior attempts
import { readFileSync } from 'fs';
import { PrivateKey, Transaction, Script, SatoshisPerKilobyte, P2PKH, LockingScript } from '@bsv/sdk';

const env = readFileSync('../.env', 'utf-8');
const wif = env.match(/DISPATCH_PRIVATE_KEY=(\S+)/)[1];
const pk = PrivateKey.fromWif(wif);
const addr = pk.toAddress();

const base = 'https://api.whatsonchain.com/v1/bsv/main';
const unspent = await fetch(`${base}/address/${addr}/unspent`).then(r => r.json());
console.log(`unspent: ${unspent.length}, picking biggest`);
const picked = unspent.sort((a,b) => b.value - a.value)[0];
const srcHex = await fetch(`${base}/tx/${picked.tx_hash}/hex`).then(r => r.text());
const srcTx = Transaction.fromHex(srcHex);

// Build TX with a UNIQUE nonce output so txid is always different
const nonce = Date.now().toString(16);

async function build(label, outputScript, satsOut = 1) {
  const tx = new Transaction();
  tx.version = 2;
  tx.addInput({
    sourceTransaction: srcTx,
    sourceOutputIndex: picked.tx_pos,
    unlockingScriptTemplate: new P2PKH().unlock(pk, 'all', false, picked.value, new P2PKH().lock(addr)),
  });
  if (outputScript) tx.addOutput({ lockingScript: Script.fromHex(outputScript), satoshis: satsOut });
  tx.addOutput({ lockingScript: new P2PKH().lock(addr), change: true });
  await tx.fee(new SatoshisPerKilobyte(500));
  await tx.sign();
  return tx;
}

async function testArcade(tx, label) {
  const efHex = tx.toHexEF();
  const r = await fetch('https://arcade-eu-1.bsvb.tech/tx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from(efHex, 'hex'),
  });
  const j = await r.json();
  console.log(`${label}: ${j.txStatus || 'UNKNOWN'}${j.extraInfo ? ' — ' + j.extraInfo.slice(0,150) : ''}${j.error ? ' — ' + j.error : ''}`);
}

// Add nonce via OP_RETURN-like pattern to ensure unique txid per run
// 1. Pure P2PKH - should work
await testArcade(await build('pure-p2pkh', null), 'P2PKH only');

// 2. With nonce OP_RETURN
await testArcade(await build('op-return', `006a0a${nonce}abcdef`), 'OP_RETURN data');

// 3. With small non-standard script (custom)
await testArcade(await build('custom-tiny', `04${nonce.padStart(8,'0')}7500`), 'Tiny custom (push/drop/0)');

// 4. Medium-size push in script (simulates covenant body)
const bigData = '4d' + 'c800' + 'aa'.repeat(200) + '75' + '00'; // PUSHDATA2 200 bytes + DROP + 00
await testArcade(await build('medium-push', bigData), 'Medium PUSHDATA2 + drop');
