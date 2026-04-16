// Try EVERY angle to get more detail from Teranode's "failed to validate"
import { readFileSync } from 'fs';
import { PrivateKey, Transaction, Script, P2PKH } from '@bsv/sdk';

const env = readFileSync('../.env', 'utf-8');
const wif = env.match(/DISPATCH_PRIVATE_KEY=(\S+)/)[1];
const pk = PrivateKey.fromWif(wif);
const addr = pk.toAddress();

const base = 'https://api.whatsonchain.com/v1/bsv/main';
const unspent = await fetch(`${base}/address/${addr}/unspent`).then(r => r.json());
const picked = unspent.sort((a,b) => b.value - a.value)[0];
console.log(`picked ${picked.tx_hash.slice(0,16)}:${picked.tx_pos} value=${picked.value}`);

const srcHex = await fetch(`${base}/tx/${picked.tx_hash}/hex`).then(r => r.text());
const srcTx = Transaction.fromHex(srcHex);

// Verify source tx is on chain
const srcCheck = await fetch(`${base}/tx/hash/${picked.tx_hash}`);
console.log(`source tx /tx/hash status: ${srcCheck.status}`);
if (srcCheck.ok) {
  const d = await srcCheck.json();
  console.log(`  confirmations: ${d.confirmations}`);
  console.log(`  blockhash: ${d.blockhash}`);
  const v = d.vout[picked.tx_pos];
  console.log(`  vout[${picked.tx_pos}] value: ${v.value}, spentTxId: ${v.spentTxId || 'null'}`);
}

// Build fresh tx with unique nonce
const tx = new Transaction();
tx.version = 2;
tx.addInput({
  sourceTransaction: srcTx,
  sourceOutputIndex: picked.tx_pos,
  unlockingScriptTemplate: new P2PKH().unlock(pk, 'all', false, picked.value, new P2PKH().lock(addr)),
});
const nonce = Date.now().toString(16).padStart(16, '0');
tx.addOutput({ lockingScript: Script.fromHex(`006a08${nonce}`), satoshis: 0 });
tx.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: picked.value - 1000 });
await tx.sign();
const txid = tx.id('hex');
console.log(`\ntx: ${txid}  size=${tx.toHex().length/2}B`);
const efHex = tx.toHexEF();

// Try different Arcade endpoints and headers
const tests = [
  { name: 'arcade-eu-1 default', url: 'https://arcade-eu-1.bsvb.tech/tx', body: Buffer.from(efHex, 'hex'), headers: { 'Content-Type': 'application/octet-stream' } },
  { name: 'arcade-eu-1 JSON', url: 'https://arcade-eu-1.bsvb.tech/tx', body: JSON.stringify({ rawTx: tx.toHex() }), headers: { 'Content-Type': 'application/json' } },
  { name: 'arcade-eu-1 verbose', url: 'https://arcade-eu-1.bsvb.tech/tx?verbose=true', body: Buffer.from(efHex, 'hex'), headers: { 'Content-Type': 'application/octet-stream', 'X-WaitForStatus': 'MINED' } },
  { name: 'arcade-ttn-us-1', url: 'https://arcade-ttn-us-1.bsvb.tech/tx', body: Buffer.from(efHex, 'hex'), headers: { 'Content-Type': 'application/octet-stream' } },
  { name: 'arcade-us-1', url: 'https://arcade-us-1.bsvb.tech/tx', body: Buffer.from(efHex, 'hex'), headers: { 'Content-Type': 'application/octet-stream' } },
  { name: 'taal mAPI', url: 'https://mapi.taal.com/mapi/tx', body: JSON.stringify({ rawtx: tx.toHex() }), headers: { 'Content-Type': 'application/json' } },
  { name: 'WoC broadcast', url: 'https://api.whatsonchain.com/v1/bsv/main/tx/raw', body: JSON.stringify({ txhex: tx.toHex() }), headers: { 'Content-Type': 'application/json' } },
];

for (const t of tests) {
  try {
    const r = await fetch(t.url, { method: 'POST', headers: t.headers, body: t.body });
    const txt = await r.text();
    console.log(`\n=== ${t.name} ===`);
    console.log(`HTTP ${r.status}`);
    console.log(`headers: content-type=${r.headers.get('content-type')}`);
    console.log(`body: ${txt.slice(0, 500)}`);
  } catch (e) {
    console.log(`\n=== ${t.name} === ERROR: ${e.message}`);
  }
}

// After all attempts, query the tx status directly
console.log(`\n\n=== POST-BROADCAST QUERIES for ${txid.slice(0,16)} ===`);
for (const ep of ['arcade-eu-1', 'arcade-ttn-us-1', 'arcade-us-1']) {
  try {
    const r = await fetch(`https://${ep}.bsvb.tech/tx/${txid}`);
    const txt = await r.text();
    console.log(`${ep}/tx/ HTTP ${r.status}: ${txt.slice(0, 300)}`);
  } catch (e) { console.log(`${ep} err: ${e.message}`); }
}
try {
  const r = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/hash/${txid}`);
  console.log(`WoC /tx/hash HTTP ${r.status}`);
} catch {}
