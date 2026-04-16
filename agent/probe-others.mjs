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

const tx = new Transaction();
tx.version = 2;
tx.addInput({
  sourceTransaction: srcTx,
  sourceOutputIndex: picked.tx_pos,
  unlockingScriptTemplate: new P2PKH().unlock(pk, 'all', false, picked.value, new P2PKH().lock(addr)),
});
// Small covenant output
tx.addOutput({ lockingScript: Script.fromHex('04010203047500'), satoshis: 1 });
tx.addOutput({ lockingScript: new P2PKH().lock(addr), change: true });
await tx.fee(new SatoshisPerKilobyte(500));
await tx.sign();

console.log(`tx: ${tx.id('hex')} ${tx.toHex().length/2}B`);
const rawHex = tx.toHex();
const efHex = tx.toHexEF();

// Test multiple broadcast endpoints
async function test(name, url, body, headers) {
  try {
    const r = await fetch(url, { method: 'POST', headers, body });
    const txt = await r.text();
    console.log(`\n${name} HTTP ${r.status}:`);
    console.log(`  ${txt.slice(0, 400)}`);
  } catch (e) { console.log(`\n${name}: ${e.message}`); }
}

// WoC broadcast
await test('WoC broadcast', 'https://api.whatsonchain.com/v1/bsv/main/tx/raw',
  JSON.stringify({ txhex: rawHex }),
  { 'Content-Type': 'application/json' });

// Bitails broadcast
await test('Bitails broadcast', 'https://api.bitails.io/tx/broadcast',
  JSON.stringify({ raw: rawHex }),
  { 'Content-Type': 'application/json' });

// Arcade-eu (for comparison)
await test('Arcade EU', 'https://arcade-eu-1.bsvb.tech/tx',
  Buffer.from(efHex, 'hex'),
  { 'Content-Type': 'application/octet-stream' });
