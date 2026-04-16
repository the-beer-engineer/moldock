import { readFileSync, writeFileSync } from 'fs';
import { PrivateKey, LockingScript } from '@bsv/sdk';
import { createHash } from 'crypto';

const env = readFileSync('../.env', 'utf-8');
const wif = env.match(/DISPATCH_PRIVATE_KEY=(\S+)/)[1];
const pk = PrivateKey.fromWif(wif);
const pubKeyBytes = pk.toPublicKey().encode(true);
const addr = pk.toAddress();

const p2pkScript = new LockingScript([
  { op: pubKeyBytes.length, data: pubKeyBytes },
  { op: 0xac }
]);
const p2pkHex = p2pkScript.toHex();
const scriptHashBuf = createHash('sha256').update(Buffer.from(p2pkHex, 'hex')).digest();
const scriptHash = Buffer.from(scriptHashBuf).reverse().toString('hex');

const base = 'https://api.whatsonchain.com/v1/bsv/main';

console.log(`[recon] Address: ${addr}`);
console.log(`[recon] Fetching actual on-chain UTXOs...`);

const p2pkUtxos = await (await fetch(`${base}/script/${scriptHash}/unspent`)).json();
const p2pkhUtxos = await (await fetch(`${base}/address/${addr}/unspent`)).json();

const all = [
  ...p2pkUtxos.map(u => ({ ...u, _type: 'p2pk', _script: p2pkHex })),
  ...(Array.isArray(p2pkhUtxos) ? p2pkhUtxos : []).map(u => ({ ...u, _type: 'p2pkh', _script: '' })),
];

console.log(`[recon] Chain has ${all.length} UTXOs, fetching source TX hex for each...`);

const persisted = [];
for (const u of all) {
  try {
    const resp = await fetch(`${base}/tx/${u.tx_hash}/hex`);
    if (!resp.ok) { console.log(`  miss ${u.tx_hash.slice(0,8)}: ${resp.status}`); continue; }
    const sourceTxHex = await resp.text();
    let script = u._script;
    if (!script) {
      // P2PKH — parse from source tx (simple: use @bsv/sdk)
      const { Transaction } = await import('@bsv/sdk');
      const tx = Transaction.fromHex(sourceTxHex);
      script = tx.outputs[u.tx_pos].lockingScript.toHex();
    }
    persisted.push({
      txid: u.tx_hash,
      vout: u.tx_pos,
      satoshis: u.value,
      script,
      sourceTxHex,
    });
  } catch (err) {
    console.log(`  err ${u.tx_hash.slice(0,8)}: ${err.message}`);
  }
  // rate limit
  await new Promise(r => setTimeout(r, 50));
}

const totalSats = persisted.reduce((s, u) => s + u.satoshis, 0);
console.log(`[recon] Collected ${persisted.length} UTXOs, ${totalSats} sats = ${(totalSats/1e8).toFixed(6)} BSV`);

// Load existing state, update utxos only
const STATE_FILE = '../.moldock-state.json';
const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
state.utxos = persisted;
writeFileSync(STATE_FILE + '.new', JSON.stringify(state));
console.log(`[recon] Wrote ${STATE_FILE}.new — review then rename to .moldock-state.json`);
