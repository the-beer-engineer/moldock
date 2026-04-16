import { readFileSync } from 'fs';
import { PrivateKey, LockingScript, Transaction } from '@bsv/sdk';
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
const p2pkhHex = `76a914${createHash('ripemd160').update(createHash('sha256').update(Buffer.from(pubKeyBytes)).digest()).digest('hex')}88ac`;
const scriptHash = Buffer.from(createHash('sha256').update(Buffer.from(p2pkHex, 'hex')).digest()).reverse().toString('hex');

const base = 'https://api.whatsonchain.com/v1/bsv/main';

// Paginate full P2PK history
async function fetchAllHistory() {
  const all = [];
  let offset = 0;
  while (true) {
    const url = offset === 0
      ? `${base}/script/${scriptHash}/history`
      : `${base}/script/${scriptHash}/history/${offset}`;
    const resp = await fetch(url);
    if (!resp.ok) break;
    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < 100) break;
    offset += data.length;
    if (offset > 10000) break; // safety
  }
  return all;
}

const hist = await fetchAllHistory();
console.log(`History TXs: ${hist.length}`);

// For each TX:
//   inputs_mine  = sum of sats we spent (inputs whose sourceTx outputs paid our scripts)
//   outputs_mine = sum of sats paid to our scripts (confirmed)
//   net = outputs_mine - inputs_mine
// Total deposited = sum of net where inputs_mine == 0  (pure external funding)
// Total withdrawn = sum of (inputs_mine - outputs_mine) for TXs where we have inputs
//                    (= sats we sent to others + fees)
// Current balance (per history) = sum of nets

const ourScripts = new Set([p2pkHex, p2pkhHex]);

let totalDeposited = 0;   // external → us
let totalWithdrawn = 0;   // us → external (includes fees)
let txsWithOurInputs = 0;
let parseFails = 0;

// Need to cache source txs for input resolution
const txCache = new Map();
async function getTx(txid) {
  if (txCache.has(txid)) return txCache.get(txid);
  try {
    const hex = await fetch(`${base}/tx/${txid}/hex`).then(r => r.text());
    const tx = Transaction.fromHex(hex);
    txCache.set(txid, tx);
    return tx;
  } catch {
    return null;
  }
}

for (let i = 0; i < hist.length; i++) {
  const txid = hist[i].tx_hash;
  const tx = await getTx(txid);
  if (!tx) { parseFails++; continue; }

  // Outputs paying us
  let outputsMine = 0;
  for (const o of tx.outputs) {
    const scriptHex = o.lockingScript?.toHex();
    if (scriptHex && ourScripts.has(scriptHex)) {
      outputsMine += o.satoshis ?? 0;
    }
  }

  // Inputs from us — look up each source TX
  let inputsMine = 0;
  for (const inp of tx.inputs) {
    const srcTxid = inp.sourceTXID ?? inp.sourceTransaction?.id('hex');
    if (!srcTxid) continue;
    const srcTx = await getTx(srcTxid);
    if (!srcTx) continue;
    const srcOut = srcTx.outputs[inp.sourceOutputIndex];
    const scriptHex = srcOut?.lockingScript?.toHex();
    if (scriptHex && ourScripts.has(scriptHex)) {
      inputsMine += srcOut.satoshis ?? 0;
    }
  }

  if (inputsMine === 0) {
    totalDeposited += outputsMine;
  } else {
    txsWithOurInputs++;
    const net = inputsMine - outputsMine; // positive = we sent out
    totalWithdrawn += net;
  }

  if (i % 20 === 0) process.stdout.write('.');
  await new Promise(r => setTimeout(r, 25));
}

console.log(`\n`);
console.log(`Parsed: ${hist.length - parseFails}/${hist.length}`);
console.log(`TXs with our inputs (spent): ${txsWithOurInputs}`);
console.log(`Total DEPOSITED (external → us): ${totalDeposited} sats = ${(totalDeposited/1e8).toFixed(6)} BSV`);
console.log(`Total WITHDRAWN (us → external + fees): ${totalWithdrawn} sats = ${(totalWithdrawn/1e8).toFixed(6)} BSV`);
console.log(`Expected remaining: ${totalDeposited - totalWithdrawn} sats = ${((totalDeposited - totalWithdrawn)/1e8).toFixed(6)} BSV`);
